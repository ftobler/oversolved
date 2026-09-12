import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { DirectoryCarrier } from '../directoryCarrier'
import { buildZipBytes, ZipCarrier } from '../zipCarrier'
import { deserializeTree, serializeTree } from '../serializer'
import type { WorkspaceCarrier } from '../carrier'
import type { WorkspaceTree } from '../types'
import { readZipBag, importBag } from '../import'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The assertion C1 suspended: an adopted STEP-like file's bytes travel with the
// workspace through a zip and back, and the document's reference to it survives
// the round-trip. The old hole was that the folder/single-file carriers wrote
// document text only; the zip carrier writes every entry now.

async function openMaterialized(carrier: WorkspaceCarrier): Promise<WorkspaceTree> {
  const tree = await carrier.open()
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'file' || tree.contents.has(id)) continue
    const entry = await carrier.read(id)
    if (entry.bytes) tree.contents.set(id, { bytes: entry.bytes })
  }
  return tree
}

function zipState() {
  return { bytes: new Uint8Array(0) }
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
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      }
    },
    async createWritable() {
      let buffer = new Uint8Array(0)
      return {
        async write(data: Uint8Array) { buffer = new Uint8Array(data) },
        async close() { state.bytes = buffer },
        async abort() {},
      }
    },
  } as unknown as FileSystemFileHandle
}

describe('export/import round-trip keeps file bytes', () => {
  beforeEach(resetWorkspaceIdb)

  function source(): ReturnType<typeof treeWith> {
    const tree = treeWith([
      documentEntry('a', 'Bracket', { text: 'kind: part\n# body\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4, 5]), 'application/step'),
    ])
    addReference(tree, 'a', 'b')
    return tree
  }

  it('an archive re-imports with the file entry id, its bytes and the reference', async () => {
    const store = new IdbWorkspaceStore()
    const bytes = await buildZipBytes(source())
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws' }, store)

    const reopened = await store.readEntry(result.workspace, 'b')
    expect(reopened).toMatchObject({ kind: 'file', name: 'b.step', mime: 'application/step' })
    expect(reopened.bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))
    expect(await new IdbCarrier(result.workspace).referencesOf('a')).toEqual(['b'])
  })

  it('a zip save then open through ZipCarrier preserves every payload byte', async () => {
    const carrier = new ZipCarrier()
    await carrier.save(source())
    const opened = await carrier.open()
    expect(opened.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))
    expect(opened.contents.get('a')?.text).toBe('kind: part\n# body\n')
  })

  async function exportedBytes(store: IdbWorkspaceStore): Promise<Uint8Array> {
    const src = await store.create('Src', { docKind: 'part' })
    await store.land(src.workspace, source())
    return buildZipBytes(deserializeTree(await store.export(src.workspace)))
  }

  it('a folder-bound import normalizes the folder on the first save', async () => {
    const store = new IdbWorkspaceStore()
    const bytes = await exportedBytes(store)
    const dir = fakeDirectory('dest')
    const target = { kind: 'folder' as const, label: 'dest', handle: dir as unknown as FileSystemDirectoryHandle }
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws', target }, store)

    const imported = deserializeTree(await store.export(result.workspace))
    await store.save(result.workspace, imported)

    const folder = new DirectoryCarrier(dir as unknown as FileSystemDirectoryHandle)
    expect(serializeTree(await openMaterialized(folder))).toEqual(serializeTree(imported))
    expect((await folder.read('b')).bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))
  })

  it('a zip-bound import normalizes the archive on the first save', async () => {
    const store = new IdbWorkspaceStore()
    const bytes = await exportedBytes(store)
    const state = zipState()
    const target = { kind: 'zip' as const, label: 'ws.zip', handle: zipHandle(state) }
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws', target }, store)

    const imported = deserializeTree(await store.export(result.workspace))
    await store.save(result.workspace, imported)
    expect(state.bytes).toEqual(await buildZipBytes(imported))
  })
})
