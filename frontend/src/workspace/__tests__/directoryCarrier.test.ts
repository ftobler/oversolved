import { describe, it, expect } from 'vitest'
import { DirectoryCarrier } from '../directoryCarrier'
import { addReference } from '../refs'
import { serializeTree } from '../serializer'
import { MANIFEST_PATH, TRASH_DIR } from '../paths'
import type { WorkspaceTree } from '../types'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// Dedicated DirectoryCarrier coverage: the on-disk layout, the no-op fixed
// point, and the manifest read-modify-write serialization under concurrent
// writers. The retired FileSystemDirectoryStore suite asserted the first two on
// its own store; these pin them on the carrier.

function sample(): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4]), 'application/step'),
  ])
  addReference(tree, 'a', 'b')
  return tree
}

// An opened tree leaves file bytes lazy; serializeTree needs them present.
async function openMaterialized(carrier: DirectoryCarrier): Promise<WorkspaceTree> {
  const tree = await carrier.open()
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'file' || tree.contents.has(id)) continue
    const entry = await carrier.read(id)
    if (entry.bytes) tree.contents.set(id, { bytes: entry.bytes })
  }
  return tree
}

describe('DirectoryCarrier layout and determinism', () => {
  it('writes the manifest, documents and files at their logical paths', async () => {
    const dir = fakeDirectory('cad')
    const carrier = new DirectoryCarrier(dir)
    await carrier.save(sample())

    expect(dir.fileNames()).toEqual([MANIFEST_PATH])
    const snapshot = dir.snapshot()
    expect(snapshot['documents/A.yaml']).toBe('kind: part\n')
    expect(Object.keys(snapshot)).toContain('files/b.step')
  })

  it('relocates a trashed payload under the trash directory', async () => {
    const dir = fakeDirectory('cad')
    const carrier = new DirectoryCarrier(dir)
    await carrier.save(sample())
    await carrier.remove('a')

    expect(Object.keys(dir.snapshot())).toContain(`${TRASH_DIR}/documents/A.yaml`)
    expect((await carrier.list()).map(entry => entry.id)).toEqual(['b'])
    // readPayload stays trash-agnostic so export can still materialize it.
    expect((await carrier.readPayload('a')).text).toBe('kind: part\n')
  })

  it('saving an opened tree unchanged is a no-op fixed point', async () => {
    const carrier = new DirectoryCarrier(fakeDirectory('cad'))
    await carrier.save(sample())
    const first = serializeTree(await openMaterialized(carrier))
    await carrier.save(await openMaterialized(carrier))
    expect(serializeTree(await openMaterialized(carrier))).toEqual(first)
  })

  it('serializes concurrent writers so no manifest update is lost', async () => {
    const dir = fakeDirectory('cad')
    const carrier = new DirectoryCarrier(dir)
    await carrier.save(sample())

    await Promise.all([
      carrier.add(documentEntry('x', 'X', { text: 'kind: part\n' })),
      carrier.add(documentEntry('y', 'Y', { text: 'kind: part\n' })),
    ])

    const ids = (await carrier.list()).map(entry => entry.id).sort()
    expect(ids).toEqual(['a', 'b', 'x', 'y'])
    expect(dir.snapshot()['documents/X.yaml']).toBe('kind: part\n')
    expect(dir.snapshot()['documents/Y.yaml']).toBe('kind: part\n')
  })
})
