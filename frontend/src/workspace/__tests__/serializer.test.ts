import { describe, it, expect, vi } from 'vitest'
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

  it('deserializeTree refuses a duplicate file path rather than letting the last one win', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    const files = serializeTree(tree)
    expect(() => deserializeTree([...files, { path: MANIFEST_PATH, data: 'workspace: other\n' }]))
      .toThrow(/Duplicate file path/)
  })

  it('deserializeTree refuses a file list with no manifest', () => {
    expect(() => deserializeTree([])).toThrow(/Manifest file is missing/)
  })

  it('a document payload carried as bytes is decoded to text, not stored as bytes', () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([104, 105])),
    ])
    const byPath = new Map(serializeTree(tree).map(file => [file.path, file]))
    // A zip reader may hand a text document back as bytes; the entry kind
    // decides which representation the tree stores.
    byPath.get('documents/A.yaml')!.data = new TextEncoder().encode('kind: part\n')

    const reopened = deserializeTree([...byPath.values()])
    expect(reopened.contents.get('a')?.text).toBe('kind: part\n')
    expect(reopened.contents.get('a')?.bytes).toBeUndefined()
  })

  it('a file payload carried as text is encoded to bytes, not stored as text', async () => {
    // jsdom's TextEncoder hands back a Uint8Array from another realm, which the
    // tree's own instanceof check rejects; pin the encoder to the test realm so
    // the branch the single-realm browser reaches is exercised here too.
    vi.stubGlobal('TextEncoder', class {
      encode(text: string): Uint8Array {
        return Uint8Array.from(text, ch => ch.charCodeAt(0))
      }
    })
    vi.resetModules()
    try {
      const serializer = await import('../serializer')
      const tree = treeWith([fileEntry('a', 'a.step', bytesOf([1, 2, 3]))])
      const files = serializer.serializeTree(tree)
      // The zip reader may hand a binary entry back as a string; the file kind
      // decides, mirroring the document case the other way.
      files.find(file => file.path === tree.manifest.entries.a.path)!.data = 'raw-bytes'

      const reopened = serializer.deserializeTree(files)
      expect(Array.from(reopened.contents.get('a')?.bytes ?? []))
        .toEqual(Array.from(new TextEncoder().encode('raw-bytes')))
      expect(reopened.contents.get('a')?.text).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('a manifest payload carried as bytes is decoded to text', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    const files = serializeTree(tree)
    files.find(file => file.path === MANIFEST_PATH)!.data =
      new TextEncoder().encode(files.find(file => file.path === MANIFEST_PATH)!.data as string)

    const reopened = deserializeTree(files)
    expect(reopened.manifest.entries.a.name).toBe('A')
  })
})
