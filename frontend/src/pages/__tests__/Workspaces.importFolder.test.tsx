import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { STORE_HANDLES, idbGetAllFrom } from '@/stores/documentStore/idb'
import { getWorkspaceStore } from '@/workspace/store'
import { readWorkspaceMeta } from '@/workspace/idbCarrier'
import { freshLocalDb } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

// The folder gesture changed meaning in C3: "open folder" was the library, and
// is now "adopt this folder as one workspace". The file-picker capability gates
// the affordance, and absence is structural on a browser that cannot pick.
const capability = { can: true }
const picker = { result: null as FileSystemDirectoryHandle | null }

vi.mock('@/adapters/fileSystemAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/fileSystemAccess')>()
  return {
    ...actual,
    canPickDirectory: () => capability.can,
    pickLibraryDirectory: async () => picker.result,
  }
})

beforeEach(() => {
  freshLocalDb()
  capability.can = true
  picker.result = null
})

function wrap() {
  return render(
    <BrowserRouter>
      <Workspaces />
    </BrowserRouter>
  )
}

// The import menu lists only the gestures the browser can perform; opening it
// is what makes the absence of an item observable.
async function openImportMenu() {
  await userEvent.click(await screen.findByTitle('Import'))
}

async function clickImportItem(label: string) {
  await openImportMenu()
  await userEvent.click(screen.getByText(label))
}

describe('Workspaces folder import', () => {
  it('offers no folder affordance where directories cannot be picked', async () => {
    capability.can = false
    wrap()
    await waitFor(() => expect(screen.getByText('No workspaces yet.')).toBeInTheDocument())
    await openImportMenu()
    expect(screen.queryByText('Import folder')).not.toBeInTheDocument()
  })

  it('adopts the picked folder as one workspace', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await clickImportItem('Import folder')

    // The grid refetched against the adopted workspace: the file that was
    // sitting in the folder is now a live entry and its name labels the tile.
    expect(await screen.findByText('Gearbox')).toBeInTheDocument()
  })

  // An import is one-shot: the folder is read and forgotten, so the tile that
  // comes out of it offers no reopen, no rebind and nothing to reconcile.
  it('leaves the imported folder behind, with no residence affordance on the tile', async () => {
    const dir = fakeDirectory('shelf')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await clickImportItem('Import folder')
    await screen.findByText('Gearbox')

    expect(screen.queryByTitle(/^Reopen/)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Save to folder')).not.toBeInTheDocument()
  })

  // A folder import is a plain copy: it lands the entries and nothing that
  // links them back to the folder. The meta row carries no provenance record and
  // no handle is remembered for a later pull.
  it('lands a plain copy with no origin record and no remembered handle', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await clickImportItem('Import folder')

    const store = getWorkspaceStore()
    await waitFor(async () => expect(await store.list()).toHaveLength(1))
    const [summary] = await store.list()
    const meta = (await readWorkspaceMeta(summary.workspace))!
    expect('provenance' in meta).toBe(false)
    expect(await idbGetAllFrom(STORE_HANDLES)).toEqual([])
  })
})
