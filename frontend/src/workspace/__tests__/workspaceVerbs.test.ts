import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { readWorkspaceMeta } from '../idbCarrier'
import {
  rememberWorkspaceHandle,
  rememberWorkspaceZipHandle,
  storedWorkspaceHandle,
  storedWorkspaceZipHandle,
} from '../workspaceHandleRegistry'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The workspace-level verbs' carrier side: a bound workspace's handle is
// remembered, a duplicate never shares it, and purge forgets it without ever
// touching the user's files.

function folderBinding(dir: ReturnType<typeof fakeDirectory>) {
  return { kind: 'folder' as const, label: dir.name, handle: dir as unknown as FileSystemDirectoryHandle }
}

describe('workspace carrier verbs', () => {
  beforeEach(resetWorkspaceIdb)

  it('create binds the target and land leaves the folder untouched', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const { workspace } = await store.create('Gearbox', { docKind: 'part', target: folderBinding(dir) })

    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrier).toEqual({ kind: 'folder', label: 'cad' })
    // A manifest-less folder binds pending: no fingerprint until the first save.
    expect(meta?.loadedFrom).toBeUndefined()

    const tree = treeWith([documentEntry(workspace, 'Gearbox', { text: 'kind: part\n' })], workspace)
    await store.land(workspace, tree)
    // Landing is working-copy-only: the folder still holds exactly what it did.
    expect(dir.fileNames()).toEqual(['Gearbox.yaml'])
    expect((await readWorkspaceMeta(workspace))?.loadedFrom).toBeUndefined()

    await store.save(workspace, tree)
    expect(dir.fileNames()).toContain('.oversolved-manifest.yaml')
    expect((await readWorkspaceMeta(workspace))?.loadedFrom?.carrier).toBe('folder')
  })

  it('duplicate of a bound workspace yields an unbound copy', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Ws', { docKind: 'part', target: folderBinding(dir) })
    const { workspace: copy } = await store.duplicate(workspace)

    const meta = await readWorkspaceMeta(copy)
    expect(meta?.carrier).toBeUndefined()
    expect(meta?.loadedFrom).toBeUndefined()
    expect(meta?.carrierDiverged).toBeUndefined()
  })

  it('purge forgets the folder handle but never deletes the folder', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    dir.putText('keep.txt', 'mine')
    const { workspace } = await store.create('Ws', { docKind: 'part', target: folderBinding(dir) })
    await rememberWorkspaceHandle(workspace, dir as unknown as FileSystemDirectoryHandle)
    expect(await storedWorkspaceHandle(workspace)).not.toBeNull()

    await store.purge(workspace)

    expect(await storedWorkspaceHandle(workspace)).toBeNull()
    expect(dir.fileNames()).toContain('keep.txt')
    await expect(store.open(workspace)).rejects.toThrow(/not found/)
  })

  it('purge forgets the zip handle but never deletes the zip file', async () => {
    const store = new IdbWorkspaceStore()
    const handle = { kind: 'file', name: 'ws.zip', bytes: new Uint8Array([1, 2, 3]) } as unknown as FileSystemFileHandle
    const { workspace } = await store.create('Ws', { docKind: 'part', target: { kind: 'zip', label: 'ws.zip', handle } })
    await rememberWorkspaceZipHandle(workspace, handle)
    expect(await storedWorkspaceZipHandle(workspace)).not.toBeNull()

    await store.purge(workspace)

    expect(await storedWorkspaceZipHandle(workspace)).toBeNull()
    // The handle object (and whatever file it names) was never written or removed.
    expect((handle as unknown as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
})
