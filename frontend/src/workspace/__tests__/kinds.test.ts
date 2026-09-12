import { describe, it, expect } from 'vitest'
import { interpretEntry, parseDocKind, refusalMessage } from '../kinds'

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
