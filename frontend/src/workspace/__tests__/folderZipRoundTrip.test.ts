import { describe, it, expect } from 'vitest'
import { readDirectoryTree, writeDirectoryTree } from '../directoryCarrier'
import { buildZipBytes, readZipFiles, readZipTree } from '../zipCarrier'
import { serializeTree } from '../serializer'
import { removeEntry } from '../tree'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The import/export endpoints, which is all a folder or an archive is: a tree
// goes out, the same tree comes back. They are held to one contract because
// they write one layout, so an archive unzipped into a folder and a folder
// zipped up are the same bytes either way round.

function sample() {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n# odd   spacing\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
  ])
  addReference(tree, 'a', 'b')
  return tree
}

const endpoints = [
  {
    name: 'folder',
    roundTrip: async (tree: ReturnType<typeof sample>) => {
      const dir = fakeDirectory('ws')
      await writeDirectoryTree(dir, tree)
      return readDirectoryTree(dir)
    },
  },
  {
    name: 'zip',
    roundTrip: async (tree: ReturnType<typeof sample>) => readZipTree(await buildZipBytes(tree)),
  },
]

describe.each(endpoints)('$name round-trip', ({ roundTrip }) => {
  it('returns the tree it was given, payloads and edges included', async () => {
    const back = await roundTrip(sample())
    expect(serializeTree(back)).toEqual(serializeTree(sample()))
    expect(back.contents.get('a')?.text).toBe('kind: part\n# odd   spacing\n')
    expect(back.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3]))
    expect(back.manifest.references).toEqual({ a: ['b'] })
  })

  it('carries a trashed entry out and back with its payload', async () => {
    const tree = sample()
    removeEntry(tree, 'a')
    const back = await roundTrip(tree)
    expect(back.manifest.trash).toEqual(['a'])
    expect(back.contents.get('a')?.text).toBe('kind: part\n# odd   spacing\n')
  })

  it('writing what it read is a fixed point', async () => {
    const once = await roundTrip(sample())
    const twice = await roundTrip(once)
    expect(serializeTree(twice)).toEqual(serializeTree(once))
  })
})

// The two endpoints agree on one layout, so the archive's entries are exactly
// the files the folder holds, under the same paths.
it('a folder and an archive of one tree hold the same files', async () => {
  const tree = sample()
  const dir = fakeDirectory('ws')
  await writeDirectoryTree(dir, tree)
  const archived = (await readZipFiles(await buildZipBytes(tree))).map(file => file.path)
  expect(archived.sort()).toEqual(Object.keys(dir.snapshot()).sort())
})
