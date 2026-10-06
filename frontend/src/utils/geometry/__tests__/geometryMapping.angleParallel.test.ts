import { describe, it, expect } from 'vitest'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import type { Sketch, PartConstraint, DimLinearRender } from '@/types/cad'

// Regression: an angle constraint between two parallel lines used to render
// as a degenerate dim_angle (vertex falls back to a midpoint, arc is
// meaningless). It now renders as a dim_linear perpendicular distance,
// matching the Dimension-tool preview's resolution for parallel picks.

function makeSketch(): Sketch {
  return {
    H1: { start: [0, 0], end: [10, 0] },        // horizontal at y=0
    H2: { start: [0, 5], end: [10, 5] },        // horizontal at y=5 (parallel)
    V1: { start: [0, 0], end: [0, 10] },        // vertical (NOT parallel to H1)
    HR: { start: [10, 5], end: [0, 5] },        // anti-parallel to H1
    PT: { x: 5, y: 3 },                         // point entity
  } as Sketch
}

describe('computeConstraintRender (angle / parallel handling)', () => {
  it('non-parallel angle → dim_angle (existing behaviour preserved)', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'A1', kind: 'angle',
      a: '$H1', b: '$V1',
      value: 90,
    }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('dim_angle')
  })

  it('parallel angle → dim_linear with the geometric perpendicular distance', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'A1', kind: 'angle',
      a: '$H1', b: '$H2',
      value: 0,
    }
    const r = computeConstraintRender(c, sketch) as DimLinearRender | { kind: string }
    expect(r.kind).toBe('dim_linear')
    expect((r as DimLinearRender).value).toBe(5)
  })

  it('anti-parallel angle (same direction, reversed) → dim_linear', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'A1', kind: 'angle',
      a: '$H1', b: '$HR',
      value: 180,
    }
    const r = computeConstraintRender(c, sketch) as DimLinearRender | { kind: string }
    expect(r.kind).toBe('dim_linear')
    expect((r as DimLinearRender).value).toBe(5)
  })

  it('parallel angle propagates pos for label placement', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'A1', kind: 'angle',
      a: '$H1', b: '$H2',
      value: 0,
      pos: [3, 2],
    }
    const r = computeConstraintRender(c, sketch) as DimLinearRender | { kind: string }
    expect(r.kind).toBe('dim_linear')
    expect((r as DimLinearRender).pos).toEqual([3, 2])
  })
})

describe('computeConstraintRender (line_distance extension-line segments)', () => {
  it('line_distance with two lines emits ext1_line and ext2_line', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'D1', kind: 'line_distance',
      a: '$H1', b: '$H2',
      value: 5,
    }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('dim_linear')
    const dim = r as DimLinearRender
    expect(dim.ext1_line).toEqual([0, 0, 10, 0])
    expect(dim.ext2_line).toEqual([0, 5, 10, 5])
  })

  it('line_distance with point target omits ext2_line', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'D1', kind: 'line_distance',
      a: '$H1', b: '$PT',
      value: 3,
    }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('dim_linear')
    const dim = r as DimLinearRender
    expect(dim.ext1_line).toEqual([0, 0, 10, 0])
    expect(dim.ext2_line).toBeUndefined()
  })

  it('length does not emit ext1_line / ext2_line', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'L1', kind: 'length',
      target: '$H1',
      value: 10,
    }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('dim_linear')
    const dim = r as DimLinearRender
    expect(dim.ext1_line).toBeUndefined()
    expect(dim.ext2_line).toBeUndefined()
  })

  it('point_distance does not emit ext1_line / ext2_line', () => {
    const sketch = makeSketch()
    const c: PartConstraint = {
      id: 'PD1', kind: 'point_distance',
      a: '$PT', b: '$PT',
      value: 0,
    }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('dim_linear')
    const dim = r as DimLinearRender
    expect(dim.ext1_line).toBeUndefined()
    expect(dim.ext2_line).toBeUndefined()
  })
})
