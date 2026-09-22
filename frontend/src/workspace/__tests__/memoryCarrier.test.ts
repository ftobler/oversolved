import { describe, it, expect } from 'vitest'
import { MemoryCarrier } from '../memoryCarrier'
import { serializeTree } from '../serializer'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'

function sample() {
  return treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3])),
  ])
}

describe('MemoryCarrier seam (I4 memory half, carrier contract)', () => {
  it('open then save round-trips a tree byte-identically', async () => {
    const tree = sample()
    const carrier = new MemoryCarrier()
    await carrier.save(tree)

    const opened = await carrier.open()
    expect(serializeTree(opened)).toEqual(serializeTree(tree))

    await carrier.save(opened)
    const reopened = await carrier.open()
    expect(serializeTree(reopened)).toEqual(serializeTree(opened))
  })

  it('save twice from the same tree produces byte-equal serializations', async () => {
    const tree = sample()
    const carrier = new MemoryCarrier()
    await carrier.save(tree)
    const first = serializeTree(await carrier.open())
    await carrier.save(tree)
    const second = serializeTree(await carrier.open())
    expect(second).toEqual(first)
  })

  it('open returns a tree that cannot alias the carrier state', async () => {
    const carrier = new MemoryCarrier(sample())
    const first = await carrier.open()
    first.manifest.entries.a.name = 'Mutated'
    first.manifest.entries.a.path = 'documents/Mutated.yaml'
    first.contents.get('b')?.bytes?.set([9, 9, 9])

    const second = await carrier.open()
    expect(second.manifest.entries.a.name).toBe('A')
    expect(second.manifest.entries.a.path).toBe('documents/A.yaml')
    expect(second.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3]))
  })

  it('list returns live metadata only and never reads content', async () => {
    const carrier = new MemoryCarrier(sample())
    const items = await carrier.list()
    expect(items).toEqual([
      { id: 'a', path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' },
      { id: 'b', path: 'files/b.step', kind: 'file', name: 'b.step', mime: 'application/octet-stream' },
    ])
    for (const item of items) {
      expect(Object.prototype.hasOwnProperty.call(item, 'text')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(item, 'bytes')).toBe(false)
    }
  })

  it('list excludes a trashed entry', async () => {
    const carrier = new MemoryCarrier(sample())
    await carrier.remove('a')
    const ids = (await carrier.list()).map(item => item.id)
    expect(ids).toEqual(['b'])
  })

  it('list can include trashed metadata when asked', async () => {
    const carrier = new MemoryCarrier(sample())
    await carrier.remove('a')
    const ids = (await carrier.list({ includeTrashed: true })).map(item => item.id)
    expect(ids).toEqual(['a', 'b'])
  })

  it('read rejects an unknown or trashed id', async () => {
    const carrier = new MemoryCarrier(sample())
    await expect(carrier.read('ghost')).rejects.toThrow()
    await carrier.remove('a')
    await expect(carrier.read('a')).rejects.toThrow(/trashed/)
  })

  it('add rejects a duplicate id and derives the path for a reserved-looking name', async () => {
    const carrier = new MemoryCarrier(sample())
    await expect(carrier.add(documentEntry('a', 'Other'))).rejects.toThrow(/already exists/)

    // The raw name is not reserved; its sanitized derived path is the identity.
    await carrier.add(documentEntry('c', '.oversolved-index.json'))
    const added = (await carrier.list()).find(meta => meta.id === 'c')
    expect(added?.path).toBe('documents/oversolved-index.json.yaml')
    expect(added?.name).toBe('.oversolved-index.json')
  })

  it('write replaces a live entry and rejects an unknown one', async () => {
    const carrier = new MemoryCarrier(sample())
    await carrier.write(documentEntry('a', 'A Edited', { text: 'kind: assembly\n', docKind: 'assembly' }))
    const entry = await carrier.read('a')
    expect(entry.name).toBe('A Edited')
    expect(entry.docKind).toBe('assembly')
    expect(entry.text).toBe('kind: assembly\n')

    await expect(carrier.write(documentEntry('ghost', 'Ghost'))).rejects.toThrow()
  })

  it('a file keeps its mime and fileKind through list and clone', async () => {
    const carrier = new MemoryCarrier(treeWith([
      { ...fileEntry('b', 'b.step', bytesOf([1, 2]), 'application/step'), fileKind: 'step' },
    ]))

    const [meta] = await carrier.list()
    expect(meta).toMatchObject({ id: 'b', kind: 'file', mime: 'application/step', fileKind: 'step' })

    const clone = await carrier.read(await carrier.clone('b'))
    expect(clone).toMatchObject({ kind: 'file', mime: 'application/step', fileKind: 'step' })
    expect(clone.bytes).toEqual(bytesOf([1, 2]))
  })

  it('an uninitialized carrier refuses to open rather than reporting an empty workspace', async () => {
    const carrier = new MemoryCarrier()
    await expect(carrier.open()).rejects.toThrow(/empty/)
    await expect(carrier.list()).rejects.toThrow(/empty/)
  })

  it('clone mints a fresh id and copies content and name', async () => {
    const tree = sample()
    addReference(tree, 'a', 'b')
    const carrier = new MemoryCarrier(tree)

    const cloneId = await carrier.clone('a')
    expect(cloneId).not.toBe('a')
    const clone = await carrier.read(cloneId)
    expect(clone.name).toBe('A (Clone)')
    expect(clone.text).toBe('kind: part\n')
    expect(clone.docKind).toBe('part')

    const opened = await carrier.open()
    expect(opened.manifest.references[cloneId]).toBeUndefined()

    const named = await carrier.clone('a', 'Copy of A')
    expect((await carrier.read(named)).name).toBe('Copy of A')
  })
})
