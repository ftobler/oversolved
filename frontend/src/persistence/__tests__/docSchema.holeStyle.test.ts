// The hole style fields' boundary checks: a counterbore/countersink spec with
// its dimensions loads and keeps them, an unknown style is refused by field,
// and a dimensional field that is neither a number nor an expression is
// refused. The solver owns the geometric ranges (mouth wider than the bore, a
// step shallower than a blind hole); the document boundary owns shape and enum.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(hole: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'part',
    features: [{
      id: 'h1',
      kind: 'hole',
      hole: { sketch: '@sk1', diameter: 4, depth_mode: 'blind', depth: 10, ...hole },
    }],
  }
}

function holeOf(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc.features as Record<string, unknown>[])[0].hole as Record<string, unknown>
}

describe('hole style document validation', () => {
  it('accepts a counterbore and keeps its dimensions', () => {
    const result = loadPartDoc(doc({ style: 'counterbore', cb_diameter: 8, cb_depth: 2 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(holeOf(result.doc)).toMatchObject({ style: 'counterbore', cb_diameter: 8, cb_depth: 2 })
  })

  it('accepts a countersink and its angle', () => {
    const result = loadPartDoc(doc({ style: 'countersink', cb_diameter: 8, cs_angle: 82 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(holeOf(result.doc)).toMatchObject({ style: 'countersink', cs_angle: 82 })
  })

  it('accepts a simple hole with no style field', () => {
    const result = loadPartDoc(doc({}))
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown style', () => {
    const result = loadPartDoc(doc({ style: 'spotface' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.style')
  })

  it('rejects a dimensional field that is not a number or expression', () => {
    const result = loadPartDoc(doc({ style: 'counterbore', cb_diameter: { value: 8 } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.cb_diameter')
  })

  it('accepts a through_all hole with no depth and keeps it absent', () => {
    const hole = { sketch: '@sk1', diameter: 4, depth_mode: 'through_all' }
    const result = loadPartDoc({ kind: 'part', features: [{ id: 'h1', kind: 'hole', hole }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(holeOf(result.doc)).not.toHaveProperty('depth')
  })

  it('refuses a blind hole with no depth and names the field', () => {
    const result = loadPartDoc({
      kind: 'part',
      features: [{ id: 'h1', kind: 'hole', hole: { sketch: '@sk1', diameter: 4, depth_mode: 'blind' } }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.depth')
    expect(result.error.message).toContain('required for a blind hole')
  })
})
