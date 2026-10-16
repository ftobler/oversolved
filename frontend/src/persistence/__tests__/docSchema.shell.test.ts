// The shell kind's boundary checks: a well-formed shell loads, and the four
// shapes that would break the solve (a non-positive thickness, a bad direction,
// a non-list faces, a bad source_body ref) are refused by field.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(shell: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'sh1', kind: 'shell', shell }] }
}

describe('shell document validation', () => {
  it('accepts a valid shell and keeps its payload', () => {
    const result = loadPartDoc(doc({ faces: ['?f1'], thickness: 'wall', direction: 'outward', source_body: '@ex1' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].shell).toEqual({
      faces: ['?f1'], thickness: 'wall', direction: 'outward', source_body: '@ex1',
    })
  })

  it('accepts an empty face list with a source body', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: 1, source_body: '@ex1' }))
    expect(result.ok).toBe(true)
  })

  it('rejects a zero thickness by field', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: 0 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.thickness')
  })

  it('rejects a negative thickness by field', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: -2 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.thickness')
  })

  it('rejects a bad direction', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: 1, direction: 'sideways' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.direction')
  })

  it('rejects a non-list faces field', () => {
    const result = loadPartDoc(doc({ faces: '?f1', thickness: 1 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.faces')
  })

  it('rejects a string thickness expression that evaluates <= 0', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: '1 - 1' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.thickness')
  })

  it('rejects a non-string source_body ref', () => {
    const result = loadPartDoc(doc({ faces: [], thickness: 1, source_body: 42 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].shell.source_body')
  })
})
