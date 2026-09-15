import { describe, it, expect, beforeEach } from 'vitest'
import type { WorkspaceCarrier } from '../carrier'
import type { WorkspaceTree } from '../types'
import { MemoryCarrier } from '../memoryCarrier'
import { IdbCarrier } from '../idbCarrier'
import { addReference } from '../refs'
import { serializeTree } from '../serializer'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb, seedWorkspace } from './idbHarness'

// One behavioral contract, run over every WorkspaceCarrier, the way
// documentStore/__tests__/contract.test.ts runs the DocumentStore seam over its
// three conformers. MemoryCarrier is written from the interface, not ported from
// IndexedDB, so a behaviour only one of them has shows up as a failure. The
// carriers differ on where file bytes live (IdbCarrier defers them), so the
// contract reads payload through read() rather than assuming an opened tree has
// every content slot.
//
// Two conformers, and that is the whole population: the permanent store and the
// in-memory twin that keeps its seam honest. A folder and an archive write and
// read a whole tree at a time and implement none of this, which is what
// folderZipRoundTrip.test.ts pins instead.
interface Adapter {
  name: string
  setup: () => void
  make: (tree: WorkspaceTree) => Promise<WorkspaceCarrier>
}

function sample(): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
  ])
  addReference(tree, 'a', 'b')
  return tree
}

const adapters: Adapter[] = [
  {
    name: 'MemoryCarrier',
    setup: () => {},
    make: async tree => new MemoryCarrier(tree),
  },
  {
    name: 'IdbCarrier',
    setup: resetWorkspaceIdb,
    make: async tree => {
      await seedWorkspace(tree)
      const carrier = new IdbCarrier(tree.manifest.workspace)
      await carrier.save(tree)
      return carrier
    },
  },
]

describe.each(adapters)('WorkspaceCarrier contract: $name', (adapter) => {
  let carrier: WorkspaceCarrier

  beforeEach(async () => {
    adapter.setup()
    carrier = await adapter.make(sample())
  })

  it('open surfaces the manifest, document text and reference edges', async () => {
    const opened = await carrier.open()
    expect(Object.keys(opened.manifest.entries).sort()).toEqual(['a', 'b'])
    expect(opened.manifest.entries.a).toMatchObject({ kind: 'document', name: 'A', docKind: 'part' })
    expect(opened.manifest.entries.b).toMatchObject({ kind: 'file', name: 'b.step', mime: 'application/step' })
    expect(opened.manifest.references).toEqual({ a: ['b'] })
    expect((await carrier.read('a')).text).toBe('kind: part\n')
  })

  it('read materializes file bytes', async () => {
    expect((await carrier.read('b')).bytes).toEqual(bytesOf([1, 2, 3]))
  })

  it('list returns live metadata without payload', async () => {
    const items = await carrier.list()
    expect(items.map(item => item.id)).toEqual(['a', 'b'])
    for (const item of items) {
      expect(item).not.toHaveProperty('text')
      expect(item).not.toHaveProperty('bytes')
    }
  })

  it('save then open is a fixed point for a document-only tree', async () => {
    const tree = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# odd   spacing\n' })])
    await carrier.save(tree)
    const first = serializeTree(await carrier.open())
    await carrier.save(await carrier.open())
    expect(serializeTree(await carrier.open())).toEqual(first)
  })

  it('remove soft-deletes, hides from list, and restore brings it back', async () => {
    await carrier.remove('a')
    expect((await carrier.list()).map(item => item.id)).toEqual(['b'])
    expect((await carrier.list({ includeTrashed: true })).map(item => item.id)).toEqual(['a', 'b'])
    await expect(carrier.read('a')).rejects.toThrow(/trashed/)
    await carrier.restore('a')
    expect((await carrier.list()).map(item => item.id)).toEqual(['a', 'b'])
    expect((await carrier.read('a')).text).toBe('kind: part\n')
  })

  it('add refuses a duplicate id and accepts a new entry', async () => {
    await expect(carrier.add(documentEntry('a', 'Other'))).rejects.toThrow(/already exists/)
    await carrier.add(documentEntry('c', 'C'))
    expect((await carrier.list()).map(item => item.id)).toContain('c')
  })

  it('write replaces a live entry and refuses an unknown or trashed one', async () => {
    await carrier.write(documentEntry('a', 'A Edited', { text: 'kind: assembly\n', docKind: 'assembly' }))
    expect(await carrier.read('a')).toMatchObject({ name: 'A Edited', docKind: 'assembly', text: 'kind: assembly\n' })

    await expect(carrier.write(documentEntry('ghost', 'Ghost'))).rejects.toThrow()
    await carrier.remove('b')
    await expect(carrier.write(fileEntry('b', 'b.step', bytesOf([9])))).rejects.toThrow(/trashed/)
  })

  it('clone mints a fresh id and copies content and name', async () => {
    const cloneId = await carrier.clone('a')
    expect(cloneId).not.toBe('a')
    expect(await carrier.read(cloneId)).toMatchObject({ name: 'A (Clone)', text: 'kind: part\n', docKind: 'part' })

    const named = await carrier.clone('a', 'Copy of A')
    expect((await carrier.read(named)).name).toBe('Copy of A')
  })

  it('open returns a tree that cannot alias the carrier state', async () => {
    const first = await carrier.open()
    first.manifest.entries.a.name = 'Mutated'
    first.manifest.references.a = []
    const second = await carrier.open()
    expect(second.manifest.entries.a.name).toBe('A')
    expect(second.manifest.references.a).toEqual(['b'])
  })
})
