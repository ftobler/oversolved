import { describe, it, expect } from 'vitest'
import { inferDocKind, interpretEntry, parseDocKind, refusalMessage } from '../kinds'

describe('document kind interpretation (I6)', () => {
  it('parseDocKind reads part, assembly and an unknown kind without coercing', () => {
    expect(parseDocKind('kind: part\n')).toBe('part')
    expect(parseDocKind('kind: assembly\n')).toBe('assembly')
    expect(parseDocKind('kind: drawing\n')).toBe('drawing')
    expect(parseDocKind('kind: 3\n')).toBeUndefined()
  })

  it('parseDocKind returns undefined for missing, empty and unparseable text', () => {
    expect(parseDocKind('name: Bracket\n')).toBeUndefined()
    expect(parseDocKind('kind: ""\n')).toBeUndefined()
    expect(parseDocKind('kind: [unclosed\n')).toBeUndefined()
  })

  it('interpretEntry refuses an unsupported document kind and names the entry', () => {
    const entry = { kind: 'document' as const, name: 'Bracket', docKind: 'drawing' }
    const result = interpretEntry(entry)
    expect(result).toEqual({ ok: false, reason: 'unsupported-doc-kind', docKind: 'drawing' })
    if (result.ok) throw new Error('expected a refusal')
    expect(refusalMessage(entry, result)).toBe("Document 'Bracket' has unsupported kind 'drawing'")
  })

  it('interpretEntry refuses a document with no kind', () => {
    const entry = { kind: 'document' as const, name: 'Bracket' }
    const result = interpretEntry(entry)
    expect(result).toEqual({ ok: false, reason: 'missing-doc-kind' })
    if (result.ok) throw new Error('expected a refusal')
    expect(refusalMessage(entry, result)).toBe("Document 'Bracket' has no kind")
  })

  it('interpretEntry interprets part and assembly, and rejects a file entry', () => {
    expect(interpretEntry({ kind: 'document', name: 'Bracket', docKind: 'part' }))
      .toEqual({ ok: true, docKind: 'part' })
    expect(interpretEntry({ kind: 'document', name: 'Gearbox', docKind: 'assembly' }))
      .toEqual({ ok: true, docKind: 'assembly' })

    const file = { kind: 'file' as const, name: 'bracket.step' }
    const result = interpretEntry(file)
    expect(result).toEqual({ ok: false, reason: 'not-a-document' })
    if (result.ok) throw new Error('expected a refusal')
    expect(refusalMessage(file, result)).toBe("Entry 'bracket.step' is not a document")
  })
})

// The shape fallback for a payload that never got its `kind` stamped. It is a
// shim over the export bug, so these pin what it may and may not guess.
describe('kind-less document inference', () => {
  const PART = [
    'features:',
    '  - id: Origin',
    '    kind: origin',
    '  - id: n5fZFV21',
    '    kind: extrude',
    '',
  ].join('\n')

  it('reads a kind-less feature list as a part', () => {
    expect(inferDocKind(PART)).toBe('part')
  })

  it('reads a placed part or a mate as an assembly', () => {
    const placed = 'features:\n  - id: f1\n    kind: part_instance\n'
    const mated = 'features:\n  - id: f1\n    kind: mate\n'
    expect(inferDocKind(placed)).toBe('assembly')
    expect(inferDocKind(mated)).toBe('assembly')
  })

  it('never second-guesses a stamped kind, known or not', () => {
    expect(inferDocKind(`kind: part\n${PART}`)).toBeUndefined()
    expect(inferDocKind(`kind: drawing\n${PART}`)).toBeUndefined()
  })

  it('declines anything that is not a feature list of identified features', () => {
    expect(inferDocKind('name: Bracket\n')).toBeUndefined()
    expect(inferDocKind('features: []\n')).toBeUndefined()
    expect(inferDocKind('features:\n  - extrude\n  - fillet\n')).toBeUndefined()
    expect(inferDocKind('features:\n  - kind: extrude\n')).toBeUndefined()  // no id
    expect(inferDocKind('features:\n  - id: a\n')).toBeUndefined()  // no kind
    expect(inferDocKind('- features\n')).toBeUndefined()
    expect(inferDocKind('features: [unclosed\n')).toBeUndefined()
  })
})
