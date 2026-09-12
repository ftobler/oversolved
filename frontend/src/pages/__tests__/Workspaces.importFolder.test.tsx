import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
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

describe('Workspaces folder import', () => {
  it('offers no folder affordance where directories cannot be picked', async () => {
    capability.can = false
    wrap()
    await waitFor(() => expect(screen.getByText('No workspaces yet.')).toBeInTheDocument())
    expect(screen.queryByTitle('Import a folder')).not.toBeInTheDocument()
  })

  it('adopts the picked folder as one workspace', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await waitFor(() => expect(screen.getByTitle('Import a folder')).toBeInTheDocument())
    await userEvent.click(screen.getByTitle('Import a folder'))

    // The grid refetched against the adopted workspace: the file that was
    // sitting in the folder is now a live entry and its name labels the tile.
    expect(await screen.findByText('Gearbox')).toBeInTheDocument()
  })

  it('offers a remembered folder as a reopen affordance', async () => {
    const store = await import('@/workspace/store').then(m => m.getWorkspaceStore())
    const { workspace } = await store.create('Folded', { docKind: 'part' })
    const { rememberWorkspaceHandle } = await import('@/workspace/workspaceHandleRegistry')
    await rememberWorkspaceHandle(workspace, fakeDirectory('cad') as unknown as FileSystemDirectoryHandle)

    wrap()
    expect(await screen.findByTitle('Reopen cad')).toBeInTheDocument()
  })
})
