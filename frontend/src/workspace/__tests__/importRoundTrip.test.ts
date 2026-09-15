import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { buildZipBytes, readZipTree } from '../zipCarrier'
import { deserializeTree } from '../serializer'
import { readDirectoryBag, readZipBag, importBag } from '../import'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The assertion C1 suspended: an adopted STEP-like file's bytes travel with the
// workspace through a zip and back, and the document's reference to it survives
// the round-trip. The old hole was that the folder/single-file carriers wrote
// document text only; the zip carrier writes every entry now.

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

  it('a zip written and read back preserves every payload byte', async () => {
    const opened = await readZipTree(await buildZipBytes(source()))
    expect(opened.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3, 4, 5]))
    expect(opened.contents.get('a')?.text).toBe('kind: part\n# body\n')
  })

  // The source of an import is forgotten at the end of the gesture, so no later
  // save can reach back into it. The folder the bytes came out of is the witness.
  it('an import writes nothing back to the folder it read', async () => {
    const store = new IdbWorkspaceStore()
    const dir = fakeDirectory('dest')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    const before = dir.fileNames()
    const result = await importBag(await readDirectoryBag(dir as unknown as FileSystemDirectoryHandle, 'ws'), { origin: 'ws' }, store)

    await store.save(result.workspace, deserializeTree(await store.export(result.workspace)))

    expect(dir.fileNames()).toEqual(before)
  })
})
