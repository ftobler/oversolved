// The move_face kind's boundary checks: a valid move_face loads (signed
// distance, expression strings accepted), and the shapes that would break the
// solve (a non-list faces, a non-finite/NaN distance) are refused by field.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(moveFace: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'mf1', kind: 'move_face', move_face: moveFace }] }
}

describe('move_face document validation', () => {
  it('accepts a valid move_face and keeps its payload', () => {
    const result = loadPartDoc(doc({ faces: ['?f1'], distance: 5 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].move_face).toEqual({ faces: ['?f1'], distance: 5 })
  })

  it('accepts a negative distance (removing material)', () => {
    expect(loadPartDoc(doc({ faces: [], distance: -3 })).ok).toBe(true)
  })

  it('accepts a distance expression string', () => {
    expect(loadPartDoc(doc({ faces: [], distance: '2*h' })).ok).toBe(true)
  })

  it('rejects a non-list faces field', () => {
    const result = loadPartDoc(doc({ faces: '?f1', distance: 5 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].move_face.faces')
  })

  it('rejects a non-finite distance by field', () => {
    const result = loadPartDoc(doc({ faces: [], distance: Number.POSITIVE_INFINITY }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].move_face.distance')
  })
})
