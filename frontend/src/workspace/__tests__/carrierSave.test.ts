import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier, readWorkspaceMeta } from '../idbCarrier'
import { DirectoryCarrier } from '../directoryCarrier'
import { buildZipBytes } from '../zipCarrier'
import { serializeTree } from '../serializer'
import { serializeManifest } from '../manifest'
import { addReference } from '../refs'
import { MANIFEST_PATH } from '../paths'
import type { WorkspaceCarrier } from '../carrier'
import type { WorkspaceTree } from '../types'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { forgetWorkspaceHandle } from '../workspaceHandleRegistry'
import { fakeDirectory, type FakeDirectoryHandle } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The explicit save is the whole point of the carrier target: a bound workspace
// writes the same folder/zip the standalone carriers would, the first save
// normalizes an adopted folder, and an IDB-only workspace stays one.

function sample(workspace: string): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'Bracket', { text: 'kind: part\n# body\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4, 5]), 'application/step'),
  ], workspace)
  addReference(tree, 'a', 'b')
  return tree
}

// An opened carrier leaves file bytes lazy; serializeTree needs them present.
async function openMaterialized(carrier: WorkspaceCarrier): Promise<WorkspaceTree> {
  const tree = await carrier.open()
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'file' || tree.contents.has(id)) continue
    const entry = await carrier.read(id)
    if (entry.bytes) tree.contents.set(id, { bytes: entry.bytes })
  }
  return tree
}

function folderBinding(dir: FakeDirectoryHandle) {
  return { kind: 'folder' as const, label: dir.name, handle: dir as unknown as FileSystemDirectoryHandle }
}

function zipState() {
  return { bytes: new Uint8Array(0), writes: 0, fail: false }
}

function zipHandle(state: ReturnType<typeof zipState>): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name: 'ws.zip',
    async getFile() {
      const bytes = state.bytes
      return {
        size: bytes.byteLength,
        lastModified: 0,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        },
      }
    },
    async createWritable() {
      state.writes += 1
      let buffer = new Uint8Array(0)
      return {
        async write(data: Uint8Array) { buffer = new Uint8Array(data) },
        async close() {
          if (state.fail) throw new Error('write failed')
          state.bytes = buffer
        },
        async abort() {},
      }
    },
  } as unknown as FileSystemFileHandle
}

describe('store.save writes the bound carrier (I4 through the save path)', () => {
  beforeEach(resetWorkspaceIdb)

  it('a folder-bound save writes what DirectoryCarrier.save writes, twice is a fixed point', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Asm', { docKind: 'assembly', target: folderBinding(dir) })
    const tree = sample(workspace)
    await store.land(workspace, tree)
    await store.save(workspace, tree)
    await store.save(workspace, tree)

    const direct = new DirectoryCarrier(fakeDirectory('other') as unknown as FileSystemDirectoryHandle)
    await direct.save(tree)

    const bound = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    expect(serializeTree(await openMaterialized(bound))).toEqual(serializeTree(await openMaterialized(direct)))
    expect((await bound.read('b')).bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))

    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrier).toEqual({ kind: 'folder', label: 'cad' })
    expect(meta?.loadedFrom?.carrier).toBe('folder')
    expect(meta?.carrierDiverged).toBe(false)
  })

  it('a zip-bound save writes the canonical archive and twice is a fixed point', async () => {
    const store = new IdbWorkspaceStore()
    const state = zipState()
    const { workspace } = await store.create('Asm', {
      docKind: 'assembly',
      target: { kind: 'zip', label: 'ws.zip', handle: zipHandle(state) },
    })
    const tree = sample(workspace)
    await store.land(workspace, tree)
    await store.save(workspace, tree)

    const expected = await buildZipBytes(tree)
    expect(state.bytes).toEqual(expected)

    await store.save(workspace, tree)
    expect(state.bytes).toEqual(expected)
    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.loadedFrom?.carrier).toBe('zip')
  })

  it('saveEntry writes the entry to the carrier, not only the checkpoint', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
    await store.saveEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
    })

    const bound = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    const opened = await bound.open()
    expect(opened.contents.get(workspace)?.text).toBe('kind: part\n# v2\n')
    expect(opened.manifest.entries[workspace]).toBeDefined()

    const idb = new IdbCarrier(workspace)
    expect(await idb.maxWorkingRev()).toBe(await idb.maxSavedRev())
  })

  it('an IDB-only workspace writes no carrier and records no loadedFrom', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v1\n',
    })
    await store.save(workspace, (await store.open(workspace)).tree)

    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrier).toBeUndefined()
    expect(meta?.loadedFrom).toBeUndefined()
    expect(meta?.carrierDiverged).toBeUndefined()
  })

  // An opened working copy leaves file bytes lazy. If the save did not
  // materialize them first, DirectoryCarrier.save would skip the file and still
  // write a manifest naming a path that is not on disk.
  it('save materializes lazy file payloads into a bound folder', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Asm', { docKind: 'assembly', target: folderBinding(dir) })
    const tree = sample(workspace)
    await store.land(workspace, tree)

    const opened = await store.open(workspace)
    expect(opened.tree.contents.has('b')).toBe(false)  // file bytes are lazy on open

    await store.save(workspace, opened.tree)

    const bound = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    expect((await bound.read('b')).bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))
    const manifest = (await bound.open()).manifest
    expect(Object.values(manifest.entries).some(row => row.path === 'files/b.step')).toBe(true)
  })

  // A revoked or vanished folder target must not checkpoint: checkpointing would
  // clear ahead and tell the user the workspace was saved when nothing reached
  // the folder.
  it('an unavailable carrier save rethrows and keeps the workspace ahead', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
    })
    await forgetWorkspaceHandle(workspace)

    const fresh = new IdbWorkspaceStore()
    const opened = await fresh.open(workspace)
    expect(opened.carrierUnavailable).toBe(true)
    await expect(fresh.save(workspace, opened.tree)).rejects.toThrow(/unavailable/)
    expect((await fresh.open(workspace)).ahead).toBe(true)
  })

  it('a manifest written behind the working copy is reported externalChanged on open', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
    await store.save(workspace, (await store.open(workspace)).tree)
    expect((await store.open(workspace)).externalChanged).toBe(false)

    // An external editor reformats the manifest: same content, different text.
    // The fingerprint re-serializes canonically, so a reformat is not a change.
    const text = dir.snapshot()[MANIFEST_PATH]
    dir.putText(MANIFEST_PATH, `# a comment\n${text}`)
    expect((await store.open(workspace)).externalChanged).toBe(false)

    // A real change (a dropped entry) moves the hash.
    const carrier = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    const manifest = (await carrier.open()).manifest
    const changed = { ...manifest, entries: { ...manifest.entries } }
    delete changed.entries[workspace]
    dir.putText(MANIFEST_PATH, serializeManifest(changed))
    expect((await store.open(workspace)).externalChanged).toBe(true)
  })
})
