import { describe, it, expect } from 'vitest'
import type { ManifestEntry, ProvenanceRecord, WorkspaceManifest } from '../types'
import { assertManifest, buildManifestIndex, emptyManifest, parseManifest, serializeManifest } from '../manifest'
import { MANIFEST_PATH } from '../paths'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'

function withEntries(entries: WorkspaceManifest['entries'], workspace = 'ws-1'): WorkspaceManifest {
  return { ...emptyManifest(workspace), entries }
}

describe('canonical manifest (I4)', () => {
  it('empty manifest serializes with the fixed top-level key order', () => {
    expect(serializeManifest(emptyManifest('ws-1'))).toBe(
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries: {}\n' +
      'references: {}\n' +
      'provenance: []\n' +
      'trash: []\n',
    )
  })

  it('the entry index alone round-trips through serializeManifest and parseManifest', () => {
    const manifest = withEntries({
      b: { path: 'files/B.step', kind: 'file', name: 'B', mime: 'application/x-step' },
      a: { path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' },
    })
    const parsed = parseManifest(serializeManifest(manifest))
    expect(parsed.entries).toEqual(buildManifestIndex(manifest.entries))
    expect(Object.keys(parsed.entries)).toEqual(['a', 'b'])
    expect(parsed.entries.a).toEqual({ path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' })
    expect(serializeManifest(parsed)).toBe(serializeManifest(manifest))
  })

  it('a file entry carries its open app kind alongside the wire mime', () => {
    const manifest = withEntries({
      b: { path: 'files/B.step', kind: 'file', name: 'B', mime: 'application/step', fileKind: 'step' },
    })
    const parsed = parseManifest(serializeManifest(manifest))
    expect(parsed.entries.b).toEqual({ path: 'files/B.step', kind: 'file', name: 'B', mime: 'application/step', fileKind: 'step' })
    expect(serializeManifest(parsed)).toBe(serializeManifest(manifest))
  })

  // The pre-C2/C0 manifest has no fileKind. Adding the field must be additive:
  // an old manifest parses, keeps the field absent, and re-emits the same bytes.
  it('parses and reserializes a manifest entry that lacks fileKind', () => {
    const text =
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  b:\n' +
      '    path: files/B.step\n' +
      '    kind: file\n' +
      '    name: B\n' +
      '    mime: application/step\n' +
      'references: {}\n' +
      'provenance: []\n' +
      'trash: []\n'
    const parsed = parseManifest(text)
    expect(parsed.entries.b).toEqual({ path: 'files/B.step', kind: 'file', name: 'B', mime: 'application/step' })
    expect(parsed.entries.b.fileKind).toBeUndefined()
    // Deterministic: re-emitting and re-parsing is a byte-stable fixed point.
    const first = serializeManifest(parsed)
    expect(serializeManifest(parseManifest(first))).toBe(first)
  })

  it('canonical manifest sorts dynamic maps and dedupes references and trash', () => {
    const manifest: WorkspaceManifest = {
      ...emptyManifest('ws-1'),
      references: { b: ['z', 'a', 'a'], a: ['m', 'm'] },
      trash: ['z', 'a', 'z'],
    }
    const parsed = parseManifest(serializeManifest(manifest))
    expect(Object.keys(parsed.references)).toEqual(['a', 'b'])
    expect(parsed.references.a).toEqual(['m'])
    expect(parsed.references.b).toEqual(['a', 'z'])
    expect(parsed.trash).toEqual(['a', 'z'])
  })

  it('the canonical manifest output matches the golden fixture', () => {
    const tree = treeWith([documentEntry('aid', 'A'), fileEntry('bid', 'B.step', bytesOf([1]))])
    tree.manifest.references = { aid: ['bid'] }
    tree.manifest.provenance = [{ entry: 'aid', origin: 'o', rev: 2, hash: 'h' }]
    tree.manifest.trash = ['bid']

    // Pinned because canonical output is only stable for a pinned compiler.
    const golden =
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  aid:\n' +
      '    path: documents/A.yaml\n' +
      '    kind: document\n' +
      '    name: A\n' +
      '    docKind: part\n' +
      '  bid:\n' +
      '    path: files/B.step\n' +
      '    kind: file\n' +
      '    name: B.step\n' +
      '    mime: application/octet-stream\n' +
      'references:\n' +
      '  aid:\n' +
      '    - bid\n' +
      'provenance:\n' +
      '  - entry: aid\n' +
      '    origin: o\n' +
      '    rev: 2\n' +
      '    hash: h\n' +
      'trash:\n' +
      '  - bid\n'
    expect(serializeManifest(tree.manifest)).toBe(golden)
  })

  it('serializeManifest is byte-stable across re-parse and repeated construction', () => {
    const entries: WorkspaceManifest['entries'] = {
      a: { path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' },
      b: { path: 'files/B.step', kind: 'file', name: 'B', mime: 'application/x-step' },
    }
    const first = serializeManifest(withEntries(entries))
    // Re-parsing the emitted bytes and re-emitting must be a fixed point.
    expect(serializeManifest(parseManifest(first))).toBe(first)
    // The same logical manifest built in reverse key order is byte-identical.
    const reversed: WorkspaceManifest['entries'] = { b: entries.b, a: entries.a }
    expect(serializeManifest(withEntries(reversed))).toBe(first)
  })

  it('serializeManifest refuses a non-integer or non-finite number', () => {
    for (const rev of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const manifest: WorkspaceManifest = {
        ...emptyManifest('ws-1'),
        provenance: [{ entry: 'a', origin: 'o', rev }],
      }
      expect(() => serializeManifest(manifest)).toThrow()
    }
  })

  it('parseManifest rejects a bad format version and a reserved entry path', () => {
    expect(() => parseManifest('format: 2\nworkspace: ws-1\nentries: {}\n')).toThrow()

    const reserved =
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  a:\n' +
      '    path: documents/.oversolved-index.json\n' +
      '    kind: document\n' +
      '    name: A\n'
    expect(() => parseManifest(reserved)).toThrow(/reserved/)

    const outside =
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  a:\n' +
      '    path: elsewhere/A.yaml\n' +
      '    kind: document\n' +
      '    name: A\n'
    expect(() => parseManifest(outside)).toThrow(/documents\/ and files\//)
  })

  it('parseManifest rejects two entries that share one path', () => {
    const manifest = withEntries({
      a: { path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' },
      b: { path: 'documents/A.yaml', kind: 'document', name: 'B', docKind: 'part' },
    })
    expect(() => serializeManifest(manifest)).toThrow(/Duplicate entry path/)

    const text =
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  a:\n' +
      '    path: documents/A.yaml\n' +
      '    kind: document\n' +
      '    name: A\n' +
      '  b:\n' +
      '    path: documents/A.yaml\n' +
      '    kind: document\n' +
      '    name: B\n'
    expect(() => parseManifest(text)).toThrow(/Duplicate entry path/)
  })

  it('the manifest holds no document text or file bytes', () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'SECRET_TEXT_MARKER: value\n' }),
      fileEntry('b', 'B.step', bytesOf([66, 89, 84, 69, 83])),
    ])
    const text = serializeManifest(tree.manifest)
    expect(text).not.toContain('SECRET_TEXT_MARKER')
    expect(text).not.toContain('BYTES')
    expect(text).not.toContain(MANIFEST_PATH)
  })
})

// A canonical manifest has a stable provenance order, independent of import
// order, because the records are sorted on a chain of tiebreaks that falls back
// to empty for every optional field the record may lack. The sort is reached
// through the public round trip since the comparator is module-private.
function orderedProvenance(records: ProvenanceRecord[]): ProvenanceRecord[] {
  return parseManifest(serializeManifest({ ...emptyManifest('ws-1'), provenance: records })).provenance
}

describe('provenance ordering (compareProvenance)', () => {
  it('orders records by entry id before any tiebreak', () => {
    const ordered = orderedProvenance([
      { entry: 'b', origin: 'o' },
      { entry: 'a', origin: 'o' },
    ])

    expect(ordered.map(record => record.entry)).toEqual(['a', 'b'])
  })

  it('breaks a shared entry id by originEntry, absent first', () => {
    const ordered = orderedProvenance([
      { entry: 'e', origin: 'o', originEntry: 'z' },
      { entry: 'e', origin: 'o' },
      { entry: 'e', origin: 'o', originEntry: 'm' },
    ])

    expect(ordered.map(record => record.originEntry)).toEqual([undefined, 'm', 'z'])
  })

  it('breaks a shared originEntry by originGroup, absent first', () => {
    const ordered = orderedProvenance([
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'z' },
      { entry: 'e', origin: 'o', originEntry: 'x' },
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'a' },
    ])

    expect(ordered.map(record => record.originGroup)).toEqual([undefined, 'a', 'z'])
  })

  it('breaks a shared group by the origin locator', () => {
    const ordered = orderedProvenance([
      { entry: 'e', origin: 'ob', originEntry: 'x', originGroup: 'g' },
      { entry: 'e', origin: 'oa', originEntry: 'x', originGroup: 'g' },
    ])

    expect(ordered.map(record => record.origin)).toEqual(['oa', 'ob'])
  })

  it('breaks a shared origin by rev, absent first and numerically', () => {
    const ordered = orderedProvenance([
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g', rev: 2 },
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g' },
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g', rev: 1 },
    ])

    expect(ordered.map(record => record.rev)).toEqual([undefined, 1, 2])
  })

  it('breaks a shared rev by hash, absent first', () => {
    const ordered = orderedProvenance([
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g', hash: 'z' },
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g', hash: 'a' },
      { entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g' },
    ])

    expect(ordered.map(record => record.hash)).toEqual([undefined, 'a', 'z'])
  })

  it('keeps identical records in insertion order (a zero comparison is stable)', () => {
    const first: ProvenanceRecord = {
      entry: 'e', origin: 'o', originEntry: 'x', originGroup: 'g', rev: 1, hash: 'h', copiedAt: 1,
    }
    const second: ProvenanceRecord = { ...first, copiedAt: 0 }

    // copiedAt is not part of the ordering, so these compare equal and the sort
    // must preserve the order they were given in.
    expect(orderedProvenance([first, second]).map(record => record.copiedAt)).toEqual([1, 0])
  })

  it('emits every optional provenance field in fixed order and omits absent ones', () => {
    const full: ProvenanceRecord = {
      entry: 'e',
      origin: 'o',
      originEntry: 'x',
      originGroup: 'g',
      originName: 'N',
      originWorkspace: 'W',
      rev: 3,
      hash: 'h',
      copiedAt: 42,
    }

    const [kept] = orderedProvenance([full])
    expect(Object.keys(kept)).toEqual([
      'entry', 'origin', 'originEntry', 'originGroup', 'originName', 'originWorkspace', 'rev', 'hash', 'copiedAt',
    ])
    expect(kept).toEqual(full)

    const [bare] = orderedProvenance([{ entry: 'e', origin: 'o' }])
    expect(Object.keys(bare)).toEqual(['entry', 'origin'])
  })
})

const docRow: ManifestEntry = { path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part' }
const fileRow: ManifestEntry = { path: 'files/A.step', kind: 'file', name: 'A.step', mime: 'application/step', fileKind: 'step' }

function manifestWith(over: Partial<WorkspaceManifest>): WorkspaceManifest {
  return { ...emptyManifest('ws-1'), ...over }
}

function manifestWithEntry(row: unknown): WorkspaceManifest {
  return { ...emptyManifest('ws-1'), entries: { a: row as ManifestEntry } }
}

// One case per refusal branch: the message names which invariant failed, so each
// is pinned rather than merely asserted to throw.
const refusals: { name: string; manifest: WorkspaceManifest; message: RegExp }[] = [
  { name: 'a null manifest', manifest: null as unknown as WorkspaceManifest, message: /Manifest must be an object/ },
  { name: 'a foreign format version', manifest: manifestWith({ format: 2 }), message: /Unsupported manifest format: 2/ },
  { name: 'an empty workspace id', manifest: manifestWith({ workspace: '' }), message: /Manifest workspace id must be a non-empty string/ },
  { name: 'entries that are not a mapping', manifest: manifestWith({ entries: [] as unknown as WorkspaceManifest['entries'] }), message: /Manifest entries must be a mapping/ },
  { name: 'an empty entry id', manifest: { ...emptyManifest('ws-1'), entries: { '': docRow } }, message: /Manifest entry id must be non-empty/ },
  { name: 'an entry row that is not an object', manifest: manifestWithEntry(null), message: /Entry a must be an object/ },
  { name: 'an entry with no path', manifest: manifestWithEntry({ ...docRow, path: '' }), message: /Entry a has no path/ },
  { name: 'an entry path outside documents and files', manifest: manifestWithEntry({ ...docRow, path: 'elsewhere/A.yaml' }), message: /Entry a path is outside documents\/ and files\// },
  { name: 'an entry path under a reserved name', manifest: manifestWithEntry({ ...docRow, path: 'documents/.oversolved-index.json' }), message: /Entry a path is reserved/ },
  { name: 'an unknown entry kind', manifest: manifestWithEntry({ ...docRow, kind: 'link' }), message: /Entry a has an unknown kind: link/ },
  { name: 'an entry with no name', manifest: manifestWithEntry({ ...docRow, name: '' }), message: /Entry a has no name/ },
  { name: 'an entry carrying a payload', manifest: manifestWithEntry({ ...docRow, text: 'kind: part\n' }), message: /Entry a carries payload in the manifest/ },
  { name: 'a document with a non-string docKind', manifest: manifestWithEntry({ ...docRow, docKind: 5 }), message: /Entry a docKind must be a string/ },
  { name: 'a file with a non-string mime', manifest: manifestWithEntry({ ...fileRow, mime: 5 }), message: /Entry a mime must be a string/ },
  { name: 'a file with a non-string fileKind', manifest: manifestWithEntry({ ...fileRow, fileKind: 5 }), message: /Entry a fileKind must be a string/ },
  { name: 'a document with a mime', manifest: manifestWithEntry({ ...docRow, mime: 'application/step' }), message: /Document entry a must not carry a mime/ },
  { name: 'a document with a fileKind', manifest: manifestWithEntry({ ...docRow, fileKind: 'step' }), message: /Document entry a must not carry a fileKind/ },
  { name: 'a file with a docKind', manifest: manifestWithEntry({ ...fileRow, docKind: 'part' }), message: /File entry a must not carry a docKind/ },
  { name: 'references that are not a mapping', manifest: manifestWith({ references: [] as unknown as WorkspaceManifest['references'] }), message: /Manifest references must be a mapping/ },
  { name: 'a reference with an empty source id', manifest: manifestWith({ references: { '': ['b'] } }), message: /Reference source id must be non-empty/ },
  { name: 'reference targets that are not an array', manifest: manifestWith({ references: { a: 'b' } as unknown as WorkspaceManifest['references'] }), message: /References from a must be an array/ },
  { name: 'a non-string reference target', manifest: manifestWith({ references: { a: [1] } as unknown as WorkspaceManifest['references'] }), message: /Reference target from a must be a string/ },
  { name: 'provenance that is not an array', manifest: manifestWith({ provenance: {} as unknown as WorkspaceManifest['provenance'] }), message: /Manifest provenance must be an array/ },
  { name: 'a provenance record that is not an object', manifest: manifestWith({ provenance: [null as unknown as ProvenanceRecord] }), message: /Provenance record must be an object/ },
  { name: 'a provenance record with no entry id', manifest: manifestWith({ provenance: [{ origin: 'o' } as ProvenanceRecord] }), message: /Provenance record has no entry id/ },
  { name: 'a provenance record with a non-string origin', manifest: manifestWith({ provenance: [{ entry: 'e' } as ProvenanceRecord] }), message: /Provenance record origin must be a string/ },
  { name: 'an empty originEntry', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', originEntry: '' }] }), message: /Provenance originEntry must be a non-empty string/ },
  { name: 'an empty originGroup', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', originGroup: '' }] }), message: /Provenance originGroup must be a non-empty string/ },
  { name: 'a non-string originName', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', originName: 5 } as unknown as ProvenanceRecord] }), message: /Provenance originName must be a string/ },
  { name: 'a non-string originWorkspace', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', originWorkspace: 5 } as unknown as ProvenanceRecord] }), message: /Provenance originWorkspace must be a string/ },
  { name: 'a non-integer rev', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', rev: 1.5 }] }), message: /Provenance rev must be an integer/ },
  { name: 'a non-string hash', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', hash: 5 } as unknown as ProvenanceRecord] }), message: /Provenance hash must be a string/ },
  { name: 'a non-integer copiedAt', manifest: manifestWith({ provenance: [{ entry: 'e', origin: 'o', copiedAt: 1.5 }] }), message: /Provenance copiedAt must be an integer/ },
  { name: 'trash that is not an array', manifest: manifestWith({ trash: {} as unknown as string[] }), message: /Manifest trash must be an array/ },
  { name: 'trash holding a non-string id', manifest: manifestWith({ trash: [1] as unknown as string[] }), message: /Manifest trash must hold entry ids/ },
  { name: 'a null carried outside a validated field', manifest: manifestWithEntry({ ...docRow, extra: null }), message: /manifest\.entries\.a\.extra contains a null or undefined value/ },
  { name: 'a nested null inside an array', manifest: manifestWithEntry({ ...docRow, extra: [null] }), message: /manifest\.entries\.a\.extra\[0\] contains a null or undefined value/ },
  { name: 'a non-integer number outside a validated field', manifest: manifestWithEntry({ ...docRow, extra: 1.5 }), message: /manifest\.entries\.a\.extra contains a non-integer number: 1\.5/ },
]

describe('assertManifest refusals', () => {
  it.each(refusals)('refuses $name', ({ manifest, message }) => {
    expect(() => assertManifest(manifest)).toThrow(message)
  })
})

describe('parseManifest input refusals', () => {
  it('reports invalid YAML with the parser message', () => {
    expect(() => parseManifest('a: [')).toThrow(/^Manifest is not valid YAML:/)
  })

  it('rejects a YAML document that is not a mapping', () => {
    expect(() => parseManifest('[]')).toThrow(/Manifest is not a mapping/)
    expect(() => parseManifest('42')).toThrow(/Manifest is not a mapping/)
  })

  it('defaults a missing entries, references, provenance and trash to empty', () => {
    expect(parseManifest('format: 1\nworkspace: ws-1\n')).toEqual(emptyManifest('ws-1'))
  })
})
