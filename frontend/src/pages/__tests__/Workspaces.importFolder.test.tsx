import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { getWorkspaceStore } from '@/workspace/store'
import { readWorkspaceMeta } from '@/workspace/idbCarrier'
import { resolveOrigin } from '@/workspace/originResolver'
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

  it('offers a remembered folder as a reopen affordance', async () => {
    const store = await import('@/workspace/store').then(m => m.getWorkspaceStore())
    const { workspace } = await store.create('Folded', { docKind: 'part' })
    const { rememberWorkspaceHandle } = await import('@/workspace/workspaceHandleRegistry')
    await rememberWorkspaceHandle(workspace, fakeDirectory('cad') as unknown as FileSystemDirectoryHandle)

    wrap()
    expect(await screen.findByTitle('Reopen cad')).toBeInTheDocument()
  })

  it('reopen surfaces a carrier changed on disk into the decision store', async () => {
    const { useCarrierChangeStore } = await import('@/stores/carrierChangeStore')
    useCarrierChangeStore.getState().reset()
    const store = getWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Folded', {
      docKind: 'part', target: { kind: 'folder', label: dir.name, handle: dir as unknown as FileSystemDirectoryHandle },
    })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Folded', docKind: 'part', text: 'kind: part\n# saved\n',
    })
    await store.save(workspace, (await store.open(workspace)).tree)
    // Drop the entry from the folder's manifest: the carrier moved underneath.
    const { parseManifest, serializeManifest } = await import('@/workspace/manifest')
    const { MANIFEST_PATH } = await import('@/workspace/paths')
    const held = parseManifest(dir.snapshot()[MANIFEST_PATH])
    const changed = { ...held, entries: { ...held.entries } }
    delete changed.entries[workspace]
    dir.putText(MANIFEST_PATH, serializeManifest(changed))

    wrap()
    await waitFor(() => expect(screen.getByTitle('Reopen cad')).toBeInTheDocument())
    await userEvent.click(screen.getByTitle('Reopen cad'))

    // The grid's Reopen feeds the check into carrierChangeStore, so entering the
    // workspace will show the decision dialog instead of silently keeping the
    // stale working copy.
    await waitFor(() => expect(useCarrierChangeStore.getState().status).toBe('changed'))
    expect(useCarrierChangeStore.getState().workspace).toBe(workspace)
    useCarrierChangeStore.getState().reset()
  })

  it('keeps two same-named sources distinct so neither can pull the other', async () => {
    const dirA = fakeDirectory('cad')
    dirA.putText('A.yaml', 'kind: part\n# A\n')
    picker.result = dirA as unknown as FileSystemDirectoryHandle
    wrap()
    await clickImportItem('Import folder')

    const dirB = fakeDirectory('cad')
    dirB.putText('B.yaml', 'kind: part\n# B\n')
    picker.result = dirB as unknown as FileSystemDirectoryHandle
    await clickImportItem('Import folder')

    const store = getWorkspaceStore()
    const cadRecords = async () => {
      const summaries = await store.list()
      const records = (await Promise.all(
        summaries.map(async summary => (await readWorkspaceMeta(summary.workspace))?.provenance ?? []),
      )).flat()
      return records.filter(record => record.originName === 'cad')
    }
    // The tile can paint from the pre-import seed, so wait for both imports to
    // have stamped their provenance before reading the locators.
    await waitFor(async () => expect(await cadRecords()).toHaveLength(2))
    const origins = (await cadRecords()).map(record => record.origin)
    expect(new Set(origins).size).toBe(2)

    // Each locator still resolves to its own folder, not the same-named other.
    const names = await Promise.all(origins.map(async origin => {
      const tree = await resolveOrigin(origin)
      return Object.values(tree!.manifest.entries).map(row => row.name).join()
    }))
    expect(names).toEqual(expect.arrayContaining(['A', 'B']))
  })
})
