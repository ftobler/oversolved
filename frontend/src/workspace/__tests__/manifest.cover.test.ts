import { describe, it, expect } from 'vitest'
import { assertManifest, emptyManifest, parseManifest, serializeManifest } from '../manifest'
import type { WorkspaceManifest } from '../types'

// The cover is an optional top-level key after `trash`: present only when the
// user picked one, so every manifest written before the field existed is
// byte-identical to what this build emits.

const docRow = { path: 'documents/A.yaml', kind: 'document' as const, name: 'A', docKind: 'part' }

function withCover(cover: string): WorkspaceManifest {
  return { ...emptyManifest('ws-1'), entries: { a: docRow }, cover }
}

describe('manifest cover', () => {
  it('a manifest with a cover round-trips byte-identical', () => {
    const first = serializeManifest(withCover('a'))
    expect(first).toBe(
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  a:\n' +
      '    path: documents/A.yaml\n' +
      '    kind: document\n' +
      '    name: A\n' +
      '    docKind: part\n' +
      'references: {}\n' +
      'trash: []\n' +
      'cover: a\n',
    )
    const parsed = parseManifest(first)
    expect(parsed.cover).toBe('a')
    expect(serializeManifest(parsed)).toBe(first)
  })

  // Pinned from before the field existed: the key is emitted only when set, so
  // a manifest without a cover still writes exactly these bytes.
  it('a manifest without a cover serializes exactly as before', () => {
    expect(serializeManifest({ ...emptyManifest('ws-1'), entries: { a: docRow } })).toBe(
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries:\n' +
      '  a:\n' +
      '    path: documents/A.yaml\n' +
      '    kind: document\n' +
      '    name: A\n' +
      '    docKind: part\n' +
      'references: {}\n' +
      'trash: []\n',
    )
    expect(serializeManifest(emptyManifest('ws-1'))).toBe(
      'format: 1\n' +
      'workspace: ws-1\n' +
      'entries: {}\n' +
      'references: {}\n' +
      'trash: []\n',
    )
  })

  // A hand-edited zip must still import: a stale choice is dropped, not refused.
  it('a cover naming an entry the manifest does not hold parses with the key dropped', () => {
    const parsed = parseManifest(serializeManifest(withCover('ghost')))
    expect(parsed.cover).toBeUndefined()
    expect(serializeManifest(parsed)).not.toContain('cover:')
  })

  it('assertManifest refuses a cover that is empty or not a string', () => {
    expect(() => assertManifest(withCover(''))).toThrow(/Manifest cover must be a non-empty string/)
    expect(() => assertManifest({ ...withCover('a'), cover: 5 as unknown as string }))
      .toThrow(/Manifest cover must be a non-empty string/)
  })

  it('the empty manifest carries no cover', () => {
    expect(emptyManifest('ws-1').cover).toBeUndefined()
  })
})
