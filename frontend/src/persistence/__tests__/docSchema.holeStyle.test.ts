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

  it('accepts a drill-point tip and its angle', () => {
    const result = loadPartDoc(doc({ tip: 'drill_point', tip_angle: 135 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(holeOf(result.doc)).toMatchObject({ tip: 'drill_point', tip_angle: 135 })
  })

  it('rejects an unknown tip', () => {
    const result = loadPartDoc(doc({ tip: 'ball' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.tip')
  })

  it('accepts a tapped thread_depth as a number or an expression', () => {
    for (const thread_depth of [15, 'depth_var * 0.75']) {
      const result = loadPartDoc(doc({ thread: { designation: 'M6x1', nominal: 6, pitch: 1 }, thread_depth }))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(holeOf(result.doc)).toMatchObject({ thread_depth })
    }
  })

  it('rejects a thread_depth that is neither a number nor an expression', () => {
    const result = loadPartDoc(doc({ thread_depth: [15] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.thread_depth')
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
