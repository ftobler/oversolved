import { describe, it, expect } from 'vitest'
import type { WorkspaceManifest } from '../types'
import { buildManifestIndex, emptyManifest, parseManifest, serializeManifest } from '../manifest'
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
