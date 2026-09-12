import { describe, it, expect } from 'vitest'
import { deserializeTree, serializeTree } from '../serializer'
import { MANIFEST_PATH } from '../paths'
import { interpretEntry } from '../kinds'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'

describe('canonical tree serialization (I4 memory half, I5 shape, I9)', () => {
  it('serializeTree emits the manifest then entries in ascending uuid order', () => {
    // Names are deliberately crossed against uuids, so path order (Alpha, Mike,
    // Zulu) differs from uuid order (a, b, c) and the assertion can tell them
    // apart.
    const tree = treeWith([
      documentEntry('c', 'Alpha'),
      documentEntry('a', 'Zulu'),
      documentEntry('b', 'Mike'),
    ])
    const paths = serializeTree(tree).map(file => file.path)
    expect(paths).toEqual([
      MANIFEST_PATH,
      'documents/Zulu.yaml',
      'documents/Mike.yaml',
      'documents/Alpha.yaml',
    ])
  })

  it('serializeTree then deserializeTree then serializeTree is byte-identical', () => {
    const tree = treeWith([
      documentEntry('a', 'Bracket', { text: 'kind: part\n# comment\tvalue: 1.0000000\n' }),
      fileEntry('b', 'bracket.step', bytesOf([0, 1, 2, 255, 254, 10, 13])),
    ])
    const first = serializeTree(tree)
    const second = serializeTree(deserializeTree(first))
    expect(second).toEqual(first)
  })

  it('document text is preserved byte-identically and never re-serialized', () => {
    const text = 'kind: part\n# odd   spacing\nvalue: 1.5000000000000\nlist: [a, b]\n'
    const tree = treeWith([documentEntry('a', 'A', { text })])
    const reopened = deserializeTree(serializeTree(tree))
    expect(reopened.contents.get('a')?.text).toBe(text)
  })

  it('an unknown document kind survives a round-trip unchanged', () => {
    const tree = treeWith([documentEntry('a', 'Draft', { text: 'kind: drawing\n', docKind: 'drawing' })])
    const reopened = deserializeTree(serializeTree(tree))
    expect(reopened.manifest.entries.a.docKind).toBe('drawing')
    const entry = { ...reopened.manifest.entries.a, id: 'a' }
    expect(interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind }).ok).toBe(false)
  })

  it('unknown file bytes survive a round-trip unchanged', () => {
    const bytes = bytesOf([137, 80, 78, 71, 0, 255, 128, 9])
    const tree = treeWith([fileEntry('a', 'image.png', bytes, 'image/png')])
    const reopened = deserializeTree(serializeTree(tree))
    expect(reopened.contents.get('a')?.bytes).toEqual(bytes)
    expect(reopened.manifest.entries.a.mime).toBe('image/png')
  })

  it('the emitted path set is exactly the manifest plus one file per entry', () => {
    const tree = treeWith([
      documentEntry('a', 'A'),
      fileEntry('b', 'B.step', bytesOf([1])),
    ])
    const paths = serializeTree(tree).map(file => file.path).sort()
    const expected = [MANIFEST_PATH, ...Object.values(tree.manifest.entries).map(row => row.path)].sort()
    expect(paths).toEqual(expected)
  })

  it('serializeTree refuses an entry with a reserved path', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    tree.manifest.entries.a.path = 'documents/.oversolved-x.yaml'
    expect(() => serializeTree(tree)).toThrow(/reserved/)
  })

  it('deserializeTree fails loudly when an entry file is missing', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])
    const files = serializeTree(tree).filter(file => file.path !== tree.manifest.entries.b.path)
    expect(() => deserializeTree(files)).toThrow(/missing/)
  })
})
