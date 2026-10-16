// The delete_face kind's boundary checks. No scalar params: `faces` is the
// whole spec, so the only shape that can be malformed is the face list itself.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(delete_face: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'df1', kind: 'delete_face', delete_face }] }
}

describe('delete_face document validation', () => {
  it('accepts a valid delete_face and keeps its payload', () => {
    const result = loadPartDoc(doc({ faces: ['?f1', '?f2'] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].delete_face).toEqual({ faces: ['?f1', '?f2'] })
  })

  it('accepts an empty face list', () => {
    expect(loadPartDoc(doc({ faces: [] })).ok).toBe(true)
  })

  it('rejects a non-list faces field by field', () => {
    const result = loadPartDoc(doc({ faces: '?f1' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].delete_face.faces')
  })

  it('rejects a non-string entry in the face list', () => {
    const result = loadPartDoc(doc({ faces: ['?f1', 42] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].delete_face.faces[1]')
  })
})
