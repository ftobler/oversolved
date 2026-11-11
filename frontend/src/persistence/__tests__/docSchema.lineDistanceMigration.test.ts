// A stored point-first `line_distance` was inert: the solver read `a` as the
// line and dropped the constraint. The loader now swaps the two refs, so an
// old document starts constraining exactly as its author drew it. The signed
// value is untouched, and the two-line form is not a point-to-line dimension.
import { describe, it, expect } from 'vitest'
import { CURRENT_DOC_VERSION, loadPartDoc } from '@/persistence/docSchema'
import type { PartConstraint, PartDoc, SketchFeature } from '@/types/cad'

function constraintsOf(doc: PartDoc): PartConstraint[] {
  return ((doc.features ?? [])[0] as SketchFeature).constraints ?? []
}

function partDoc(version: number, constraints: Array<Record<string, unknown>>) {
  return {
    version,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'l1', kind: 'line' },
          { id: 'l2', kind: 'line' },
          { id: 'p1', kind: 'point' },
          { id: 'c1', kind: 'circle' },
        ],
        initial: {
          l1: [0, 0, 10, 0],
          l2: [0, 5, 10, 5],
          p1: [3, 4],
          c1: [3, 4, 2],
        },
        constraints,
      },
    ],
  }
}

describe('line_distance operand-order migration', () => {
  it('rewrites a stored point-first dimension to line-first and keeps its sign', () => {
    const result = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: '$p1xy', b: '$l1', value: 4, sign: -1 },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toContain('line-distance-operand-order')
    const c = constraintsOf(result.doc)[0]
    expect(c.a).toBe('$l1')
    expect(c.b).toBe('$p1xy')
    expect(c.value).toBe(4)
    expect(c.sign).toBe(-1)
  })

  it('moves a curve out of the line slot', () => {
    const result = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: '$c1', b: '$l1', value: 4 },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const c = constraintsOf(result.doc)[0]
    expect(c.a).toBe('$l1')
    expect(c.b).toBe('$c1')
  })

  it('moves a pre-resolved external point out of the line slot', () => {
    const result = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: { external_xy: [3, 4] }, b: '$l1', value: 4 },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const c = constraintsOf(result.doc)[0]
    expect(c.a).toBe('$l1')
    expect(c.b).toEqual({ external_xy: [3, 4] })
  })

  it('also moves a builtin point out of the line slot', () => {
    const result = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: '@builtin_origin', b: '$l1', value: 0 },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const c = constraintsOf(result.doc)[0]
    expect(c.a).toBe('$l1')
    expect(c.b).toBe('@builtin_origin')
  })

  it('is idempotent: reloading the migrated document applies nothing', () => {
    const first = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: '$p1xy', b: '$l1', value: 4 },
    ]))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.migrations).toContain('line-distance-operand-order')
    const second = loadPartDoc(structuredClone(first.doc))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.migrations).toEqual([])
    const c = constraintsOf(second.doc)[0]
    expect(c.a).toBe('$l1')
    expect(c.b).toBe('$p1xy')
  })

  it('leaves the two-line form and a current document alone', () => {
    const twoLines = loadPartDoc(partDoc(6, [
      { id: 'd1', kind: 'line_distance', a: '$l2', b: '$l1', value: 5 },
    ]))
    expect(twoLines.ok).toBe(true)
    if (!twoLines.ok) return
    const c = constraintsOf(twoLines.doc)[0]
    expect(c.a).toBe('$l2')
    expect(c.b).toBe('$l1')

    const current = loadPartDoc(partDoc(CURRENT_DOC_VERSION, [
      { id: 'd1', kind: 'line_distance', a: '$p1xy', b: '$l1', value: 4 },
    ]))
    expect(current.ok).toBe(true)
    if (!current.ok) return
    expect(current.migrations).toEqual([])
    const untouched = constraintsOf(current.doc)[0]
    // A document stamped at the current version is the author's: the loader
    // does not rewrite it behind their back.
    expect(untouched.a).toBe('$p1xy')
    expect(untouched.b).toBe('$l1')
  })
})
