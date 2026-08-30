import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import Documents from '@/pages/Documents'
import { useLibraryStore } from '@/stores/libraryStore'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The sidebar half of the feature: which library is live, and the fact that
// none of it appears on a browser that cannot pick directories.
const capability = { can: true }
const picker = { result: null as FileSystemDirectoryHandle | null }
const registry = { forgotten: 0 }

vi.mock('@/adapters/fileSystemAccess', () => ({
  canPickDirectory: () => capability.can,
  pickLibraryDirectory: async () => picker.result,
}))

vi.mock('@/stores/documentStore/libraryHandleRegistry', () => ({
  rememberLibraryHandle: async () => undefined,
  restoreLibraryHandle: async () => null,
  reopenLibraryHandle: async () => null,
  rememberedLibraryName: async () => null,
  forgetLibraryHandle: async () => { registry.forgotten += 1 },
}))

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  capability.can = true
  picker.result = null
  registry.forgotten = 0
  useLibraryStore.getState().useBrowserStorage()
  useLibraryStore.setState({ remembered: null, error: null, canOpenFolder: false })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => { vi.useRealTimers() })

function wrap() {
  return render(
    <BrowserRouter>
      <Documents />
    </BrowserRouter>
  )
}

async function boot() {
  await act(async () => { await useLibraryStore.getState().restore() })
}

describe('Documents library sidebar', () => {
  // Absence is structural. On Firefox and Safari the sidebar is exactly what it
  // was before this feature existed: no group, no dead "Open folder" entry.
  it('shows no library group at all when directories cannot be picked', async () => {
    capability.can = false
    await boot()
    wrap()
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument())
    expect(screen.queryByText('Library')).not.toBeInTheDocument()
    expect(screen.queryByText('Open folder...')).not.toBeInTheDocument()
    expect(screen.queryByText('Browser storage')).not.toBeInTheDocument()
  })

  it('offers browser storage and an open-folder entry where it can', async () => {
    await boot()
    wrap()
    expect(await screen.findByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Browser storage')).toBeInTheDocument()
    expect(screen.getByText('Open folder...')).toBeInTheDocument()
  })

  it('names the opened folder and lists its documents instead', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle
    await boot()
    wrap()
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Open folder...'))
    expect(await screen.findByText('cad')).toBeInTheDocument()
    // The grid refetched against the folder: the file that was sitting in it is
    // adopted and shown, without anything re-mounting the page.
    expect(await screen.findByText('Gearbox')).toBeInTheDocument()
  })

  it('goes back to browser storage and forgets the folder on close', async () => {
    picker.result = fakeDirectory('cad') as unknown as FileSystemDirectoryHandle
    await boot()
    wrap()
    await userEvent.click(await screen.findByText('Open folder...'))
    await screen.findByText('cad')

    await userEvent.click(screen.getByTitle('Stop using this folder (the files stay where they are)'))
    await waitFor(() => expect(screen.queryByText('cad')).not.toBeInTheDocument())
    expect(registry.forgotten).toBe(1)
    expect(useLibraryStore.getState().kind).toBe('browser')
  })

  // A remembered folder is an entry to click, because the browser drops the
  // write grant when the tab closes and re-asking needs a user gesture.
  it('offers a remembered folder as a clickable entry', async () => {
    useLibraryStore.setState({ canOpenFolder: true, remembered: 'cad' })
    wrap()
    const entry = await screen.findByTitle('Reopen this folder (the browser needs permission again)')
    expect(entry).toHaveTextContent('cad')
  })
})
