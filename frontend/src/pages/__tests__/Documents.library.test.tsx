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
const capability = { can: true, canFile: true }
const picker = {
  result: null as FileSystemDirectoryHandle | null,
  file: null as FileSystemFileHandle | null,
}
const registry = { forgotten: 0 }

vi.mock('@/adapters/fileSystemAccess', () => ({
  canPickDirectory: () => capability.can,
  canPickFiles: () => capability.canFile,
  pickLibraryDirectory: async () => picker.result,
  pickDocumentToOpen: async () => picker.file,
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
  capability.canFile = true
  picker.result = null
  picker.file = null
  registry.forgotten = 0
  useLibraryStore.getState().useBrowserStorage()
  useLibraryStore.setState({
    remembered: null, error: null, canOpenFolder: false, canOpenFile: false,
  })
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
    capability.canFile = false
    await boot()
    wrap()
    await waitFor(() => expect(screen.getByText('No documents yet.')).toBeInTheDocument())
    expect(screen.queryByText('Storage')).not.toBeInTheDocument()
    expect(screen.queryByText('Open folder...')).not.toBeInTheDocument()
    expect(screen.queryByText('Open file...')).not.toBeInTheDocument()
    expect(screen.queryByText('Browser storage')).not.toBeInTheDocument()
  })

  it('offers browser storage and an open-folder entry where it can', async () => {
    await boot()
    wrap()
    expect(await screen.findByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Browser storage')).toBeInTheDocument()
    expect(screen.getByText('Open folder...')).toBeInTheDocument()
  })

  // One opened file is a library of exactly one document, so the gestures that
  // need a second file have nothing to mean and are not offered.
  it('hides the add and import gestures for a single opened file', async () => {
    const bytes = new TextEncoder().encode('kind: part\n')
    picker.file = {
      kind: 'file',
      name: 'Bracket.yaml',
      async getFile() {
        return {
          name: 'Bracket.yaml', size: bytes.length, type: '', lastModified: 0,
          async text() { return new TextDecoder().decode(bytes) },
          async arrayBuffer() { return bytes.buffer },
        } as unknown as File
      },
      async createWritable() {
        return { async write() {}, async close() {}, async abort() {} }
      },
    } as unknown as FileSystemFileHandle

    await boot()
    wrap()
    expect(await screen.findByTitle('Add part')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Open file...'))
    // Twice: the sidebar names the open file, and the grid shows it as the one
    // document that library contains.
    expect(await screen.findAllByText('Bracket')).toHaveLength(2)
    expect(screen.queryByTitle('Add part')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Add assembly')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Import STEP, YAML, or .oversolved bundle')).not.toBeInTheDocument()
    // Duplicate needs a second file and Delete needs a parent directory to
    // delete from; both would reach the store's refusal as a raw error banner.
    expect(screen.queryByTitle('Duplicate')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete document')).not.toBeInTheDocument()
    expect(screen.getByTitle('Export YAML')).toBeInTheDocument()  // still meaningful
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

  // Closing a file the user opened on top of their folder must not throw the
  // folder away: the close button is shared, but only a folder is forgotten.
  it('keeps the remembered folder when a single file is closed', async () => {
    picker.result = fakeDirectory('cad') as unknown as FileSystemDirectoryHandle
    picker.file = {
      kind: 'file',
      name: 'Bracket.yaml',
      async getFile() {
        return {
          name: 'Bracket.yaml', size: 0, type: '', lastModified: 0,
          async text() { return '' },
          async arrayBuffer() { return new ArrayBuffer(0) },
        } as unknown as File
      },
      async createWritable() {
        return { async write() {}, async close() {}, async abort() {} }
      },
    } as unknown as FileSystemFileHandle

    await boot()
    wrap()
    await userEvent.click(await screen.findByText('Open file...'))
    await screen.findAllByText('Bracket')

    await userEvent.click(screen.getByTitle('Close this file (it stays where it is)'))
    await waitFor(() => expect(useLibraryStore.getState().kind).toBe('browser'))
    expect(registry.forgotten).toBe(0)
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
