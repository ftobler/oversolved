import { describe, it, expect } from 'vitest'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import { computeNaturalDimensionValue } from '@/utils/geometry/dimensionNaturalValue'
import type { Sketch, PartConstraint, DimLinearRender } from '@/types/cad'

// Dimension between two concentric circles/arcs: the value is the radial gap
// |rA - rB|. It renders as a radial linear dimension (reusing dim_linear) so it
// gets natural-value pre-fill, label placement, and editing for free.

function makeSketch(): Sketch {
  return {
    C1: { center: [0, 0], radius: 2 },
    C2: { center: [0, 0], radius: 5 },  // concentric, larger
    A1: { center: [0, 0], radius: 3, angle_start: 0, angle_end: 90, start: [3, 0], end: [0, 3] },
  } as Sketch
}

describe('computeConstraintRender (radius_difference)', () => {
  it('renders a radial dim_linear with the gap as its length', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'RD1', kind: 'radius_difference', a: '$C1', b: '$C2' }
    const r = computeConstraintRender(c, sketch) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    // Inner radius 2, outer radius 5, along +x from the shared center.
    expect(r.p1).toEqual([2, 0])
    expect(r.p2).toEqual([5, 0])
    expect(r.value).toBe(3)
    expect(Math.hypot(r.p2[0] - r.p1[0], r.p2[1] - r.p1[1])).toBe(3)
  })

  it('is order-independent (gap is the absolute difference)', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'RD1', kind: 'radius_difference', a: '$C2', b: '$C1' }
    const r = computeConstraintRender(c, sketch) as DimLinearRender
    expect(r.value).toBe(3)
    expect(r.p1).toEqual([2, 0])  // still inner first
  })

  it('shows the constraint value once set, not the live measure', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'RD1', kind: 'radius_difference', a: '$C1', b: '$C2', value: 4 }
    const r = computeConstraintRender(c, sketch) as DimLinearRender
    expect(r.value).toBe(4)
  })

  it('works for a circle/arc pair', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'RD1', kind: 'radius_difference', a: '$C1', b: '$A1' }
    const r = computeConstraintRender(c, sketch) as DimLinearRender
    expect(r.value).toBe(1)  // |2 - 3|
  })

  it('natural value pre-fill equals the radial gap', () => {
    const sketch = makeSketch()
    const v = computeNaturalDimensionValue('radius_difference', ['entity:S1:C1', 'entity:S1:C2'], sketch, 'S1')
    expect(v).toBe(3)
  })
})
