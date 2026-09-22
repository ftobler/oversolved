import { describe, it, expect, vi } from 'vitest'
import {
  unflattenGeometry,
  geomPoint,
  computeConstraintRender,
  deriveConstraints,
} from '@/utils/geometry/geometryMapping'
import { getDefaultParams } from '@/registry'
import type {
  Sketch,
  PartFeature,
  PartConstraint,
  SymbolRender,
  DimLinearRender,
  DimRadiusRender,
  DimDiameterRender,
  LineSegment,
  Circle,
  Arc,
  Ellipse,
  Spline,
  PointEntity,
} from '@/types/cad'

// Gaps the older geometryMapping suites leave open: the construction flag and
// the params-fallback arms of unflattenGeometry, the exact radius/diameter and
// directional linear renders, the full-id-first tie-break in resolveQueryRef,
// and the residual-0 filter in deriveConstraints. The per-kind symbol_* and
// angle/parallel renders live in geometryMapping.constraintRender.test.ts,
// geometryMapping.fallbackGlyph.test.ts and geometryMapping.angleParallel.test.ts.

// The fallback branch of unflattenGeometry is only observable through
// getDefaultParams: every registry default is all-zeros, so a zero result cannot
// tell "defaults were consulted" from "no params at all". Spy on the real
// implementation so the fallback has an identifiable value.
vi.mock('@/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/registry')>()
  return { ...actual, getDefaultParams: vi.fn(actual.getDefaultParams) }
})

describe('unflattenGeometry construction flag', () => {
  it('propagates the construction flag on every kind, including point', () => {
    const s = unflattenGeometry(
      { L: [1, 2, 3, 4], C: [5, 6, 7], A: [0, 0, 2, 0, 0], E: [1, 1, 4, 2, 0], S: [0, 0, 1, 1, 2, 1, 3, 0], P: [8, 9] },
      [
        { id: 'L', kind: 'line', construction: true },
        { id: 'C', kind: 'circle', construction: true },
        { id: 'A', kind: 'arc', construction: true },
        { id: 'E', kind: 'ellipse', construction: true },
        { id: 'S', kind: 'spline', construction: true },
        { id: 'P', kind: 'point', construction: true },
      ],
    )
    expect((s['L'] as LineSegment).construction).toBe(true)
    expect((s['C'] as Circle).construction).toBe(true)
    expect((s['A'] as Arc).construction).toBe(true)
    expect((s['E'] as Ellipse).construction).toBe(true)
    expect((s['S'] as Spline).construction).toBe(true)
    expect((s['P'] as PointEntity).construction).toBe(true)
  })

  it('omits the construction flag when it is absent or false', () => {
    const s = unflattenGeometry(
      { P: [1, 2], L: [0, 0, 1, 1] },
      [{ id: 'P', kind: 'point' }, { id: 'L', kind: 'line', construction: false }],
    )
    expect(s['P']).toEqual({ x: 1, y: 2 })
    expect(s['L']).toEqual({ start: [0, 0], end: [1, 1] })
  })
})

describe('unflattenGeometry params and input edge cases', () => {
  it('consults the registry default for the normalized kind when params are missing', () => {
    vi.mocked(getDefaultParams).mockReturnValueOnce([11, 22, 33, 44])
    const s = unflattenGeometry(undefined, [{ id: 'L', kind: 'projected_line' }])
    expect(s).toEqual({ L: { start: [11, 22], end: [33, 44] } })
    expect(getDefaultParams).toHaveBeenCalledWith('line')
  })

  it('fills zeros for a params array shorter than the kind expects without throwing', () => {
    const s = unflattenGeometry({ L: [5] }, [{ id: 'L', kind: 'line' }])
    expect(s).toEqual({ L: { start: [5, 0], end: [0, 0] } })
  })

  it('an empty params array fills zeros without throwing', () => {
    const s = unflattenGeometry({ C: [] }, [{ id: 'C', kind: 'circle' }])
    expect(s).toEqual({ C: { center: [0, 0], radius: 0 } })
  })

  it('skips an entity whose kind has no unflattener', () => {
    const s = unflattenGeometry({ X: [1, 2] }, [{ id: 'X', kind: 'hexagon' }])
    expect(s).toEqual({})
  })

  it('returns an empty sketch when entities or flat are undefined', () => {
    expect(unflattenGeometry({ L: [1, 2, 3, 4] }, undefined)).toEqual({})
    expect(unflattenGeometry(undefined, [{ id: 'L', kind: 'line' }])).toEqual({ L: { start: [0, 0], end: [0, 0] } })
  })

  it('defaults arc / ellipse / spline / point to zero params when missing', () => {
    // Every entity must be present in the result even with no solved params,
    // or the sketch editor drops it from the canvas.
    const s = unflattenGeometry(undefined, [
      { id: 'A', kind: 'arc' },
      { id: 'E', kind: 'ellipse' },
      { id: 'S', kind: 'spline' },
      { id: 'P', kind: 'point' },
    ])
    expect(s['A']).toEqual({ center: [0, 0], radius: 0, angle_start: 0, angle_end: 0, start: [0, 0], end: [0, 0] })
    expect(s['E']).toEqual({ center: [0, 0], a: 0, b: 0, theta: 0 })
    expect(s['S']).toEqual({ p1: [0, 0], p2: [0, 0], p3: [0, 0], p4: [0, 0] })
    expect(s['P']).toEqual({ x: 0, y: 0 })
  })
})

describe('computeConstraintRender when every operand is gone', () => {
  // A deleted entity must not make the renderer throw; each kind degrades to
  // `unknown`, which the public wrapper then turns into the generic glyph only
  // if some other operand still anchors a point. With nothing left there is no
  // anchor, so the result is the bare unknown and deriveConstraints drops it.
  const empty: Sketch = {}
  const gone = (kind: string, extra: Record<string, unknown> = {}): PartConstraint =>
    ({ id: 'c', kind, ...extra } as PartConstraint)

  it('degrades every dimension and symbol kind to unknown', () => {
    expect(computeConstraintRender(gone('length', { target: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('radius', { target: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('diameter', { target: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('horizontal', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('vertical', { target: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('normal', { a: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('parallel', { a: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('angle', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('equal_length', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('point_distance', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('point_distance_x', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('line_distance', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('radius_difference', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('midpoint', { line: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('concentric', { a: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('fixed', { target: '$GONE' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('tangent', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('colinear', { a: '$G1' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('coincident', { a: '$G1', b: '$G2' }), empty)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender(gone('ngon', { refs: ['$G1', '$G2'] }), empty)).toEqual({ kind: 'unknown' })
  })
})

describe('geomPoint key handling the relational suites do not reach', () => {
  const sketch: Sketch = {
    L: { start: [1, 2], end: [3, 4] },
    A: { center: [5, 6], radius: 2, angle_start: 0, angle_end: 90, start: [7, 6], end: [5, 8] },
    C: { center: [9, 10], radius: 3 },
    P: { x: 11, y: 12 },
  }

  it('a line treats any non-end key as start, an arc defaults to start', () => {
    expect(geomPoint(sketch, { entity: 'L', point: 'center' })).toEqual([1, 2])
    expect(geomPoint(sketch, { entity: 'A' })).toEqual([7, 6])
  })

  it('a circle ignores the key and a point ignores an unusual key', () => {
    expect(geomPoint(sketch, { entity: 'C', point: 'start' })).toEqual([9, 10])
    expect(geomPoint(sketch, { entity: 'P', point: 'xy' })).toEqual([11, 12])
    expect(geomPoint(sketch, { entity: 'nope' })).toBeNull()
  })
})

describe('computeConstraintRender - radius / diameter exact extent', () => {
  const sketch: Sketch = {
    C: { center: [1, 2], radius: 3 },
    A: { center: [5, 5], radius: 3, angle_start: 0, angle_end: 90, start: [8, 5], end: [5, 8] },
  }

  it('radius on a circle measures center to the +x rim', () => {
    const r = computeConstraintRender({ id: 'R', kind: 'radius', target: '$C', value: 3 }, sketch) as DimRadiusRender
    expect(r).toEqual({ kind: 'dim_radius', p1: [1, 2], p2: [4, 2], value: 3, entity: 'C' })
  })

  it('radius on an arc measures center to its start point', () => {
    const r = computeConstraintRender({ id: 'R', kind: 'radius', target: '$A', value: 3 }, sketch) as DimRadiusRender
    expect(r).toEqual({ kind: 'dim_radius', p1: [5, 5], p2: [8, 5], value: 3, entity: 'A' })
  })

  it('diameter spans the full width through the center for a circle and an arc', () => {
    const circle = computeConstraintRender({ id: 'D', kind: 'diameter', target: '$C', value: 6 }, sketch) as DimDiameterRender
    expect(circle).toEqual({ kind: 'dim_diameter', p1: [-2, 2], p2: [4, 2], value: 6, entity: 'C' })
    const arc = computeConstraintRender({ id: 'D', kind: 'diameter', target: '$A', value: 6 }, sketch) as DimDiameterRender
    expect(arc).toEqual({ kind: 'dim_diameter', p1: [2, 5], p2: [8, 5], value: 6, entity: 'A' })
  })

  it('radius and diameter with a missing target are unknown', () => {
    expect(computeConstraintRender({ id: 'R', kind: 'radius', target: '$GONE' }, sketch)).toEqual({ kind: 'unknown' })
    expect(computeConstraintRender({ id: 'D', kind: 'diameter', target: '$GONE' }, sketch)).toEqual({ kind: 'unknown' })
  })
})

describe('computeConstraintRender - linear normal', () => {
  const sketch: Sketch = {
    L: { start: [0, 0], end: [3, 4] },
    D: { start: [2, 2], end: [2, 2] },
    P1: { x: 0, y: 0 },
    P2: { x: 3, y: 4 },
    SAME: { x: 2, y: 2 },
    SAME2: { x: 2, y: 2 },
  }

  it('length uses the unit perpendicular of the segment, with the zero-length fallback', () => {
    const r = computeConstraintRender({ id: 'L', kind: 'length', target: '$L', value: 5 }, sketch) as DimLinearRender
    expect(r).toEqual({
      kind: 'dim_linear', p1: [0, 0], p2: [3, 4], value: 5, normal: [-4 / 5, 3 / 5], entity: 'L',
    })
    const degenerate = computeConstraintRender({ id: 'L', kind: 'length', target: '$D' }, sketch) as DimLinearRender
    expect(degenerate).toEqual({
      kind: 'dim_linear', p1: [2, 2], p2: [2, 2], value: 0, normal: [0, 1], entity: 'D',
    })
  })

  it('point_distance renders along the two points, with the coincident fallback', () => {
    const r = computeConstraintRender({ id: 'D', kind: 'point_distance', a: '$P1', b: '$P2', value: 5 }, sketch) as DimLinearRender
    expect(r).toEqual({
      kind: 'dim_linear', p1: [0, 0], p2: [3, 4], value: 5, normal: [-4 / 5, 3 / 5], entity: 'P1',
    })
    const coincident = computeConstraintRender({ id: 'D', kind: 'point_distance', a: '$SAME', b: '$SAME2' }, sketch) as DimLinearRender
    expect(coincident.normal).toEqual([0, 1])
  })
})

describe('computeConstraintRender - point_distance_x / y projection', () => {
  const sketch: Sketch = {
    P1: { x: 1, y: 2 },
    P2: { x: 5, y: 8 },
  }

  it('point_distance_x projects both points onto the shared y and emits vertical extension lines', () => {
    const r = computeConstraintRender({ id: 'X', kind: 'point_distance_x', a: '$P1', b: '$P2', value: 7 }, sketch) as DimLinearRender
    expect(r).toEqual({
      kind: 'dim_linear',
      dimKind: 'point_distance_x',
      p1: [1, 5], p2: [5, 5],
      value: 7, normal: [0, 1], entity: 'P1',
      ext1_line: [-99, 2, 101, 2],
      ext2_line: [-95, 8, 105, 8],
    })
  })

  it('point_distance_y projects both points onto the shared x and emits horizontal extension lines', () => {
    const r = computeConstraintRender({ id: 'Y', kind: 'point_distance_y', a: '$P1', b: '$P2', value: 4 }, sketch) as DimLinearRender
    expect(r).toEqual({
      kind: 'dim_linear',
      dimKind: 'point_distance_y',
      p1: [3, 2], p2: [3, 8],
      value: 4, normal: [1, 0], entity: 'P1',
      ext1_line: [1, -98, 1, 102],
      ext2_line: [5, -92, 5, 108],
    })
  })
})

describe('resolveQueryRef full-id-first tie-break', () => {
  const sketch: Sketch = {
    ab: { start: [0, 0], end: [1, 1] },
    abcenter: { start: [20, 20], end: [30, 30] },
  }

  it('a full entity id wins over a vertex-key suffix split', () => {
    // '$abcenter' is itself an entity, so it must not split into ab + 'center'.
    const r = computeConstraintRender({ id: 'F', kind: 'fixed', target: '$abcenter' }, sketch) as SymbolRender
    expect(r).toEqual({ kind: 'symbol_fixed', at: [20, 20], entity: 'abcenter' })
  })

  it('splits when the full string is not an entity, even when the residual id ends in a key word', () => {
    // '$abcenterend' is not an entity; it splits into abcenter + 'end'.
    const r = computeConstraintRender({ id: 'F', kind: 'fixed', target: '$abcenterend' }, sketch) as SymbolRender
    expect(r).toEqual({ kind: 'symbol_fixed', at: [30, 30], entity: 'abcenter', point: 'end' })
  })

  it('a ref without a $ prefix never resolves', () => {
    expect(computeConstraintRender({ id: 'F', kind: 'fixed', target: 'abcenter' }, sketch)).toEqual({ kind: 'unknown' })
  })
})

describe('deriveConstraints residual filter', () => {
  it('keeps a renderable constraint with residual 0 and drops one whose ref is gone', () => {
    const feature: PartFeature = {
      id: 'sk',
      kind: 'sketch',
      constraints: [
        { id: 'ok', kind: 'fixed', target: '$P' },
        { id: 'bad', kind: 'fixed', target: '$GONE' },
      ],
    }
    const m = deriveConstraints(feature, { P: { x: 1, y: 2 } } as Sketch)
    expect(Object.keys(m)).toEqual(['ok'])
    expect(m['ok']).toEqual({
      render: { kind: 'symbol_fixed', at: [1, 2], entity: 'P' },
      residual: 0,
    })
  })

  it('returns an empty map when the feature has no constraints', () => {
    expect(deriveConstraints({ id: 'sk', kind: 'sketch' }, {} as Sketch)).toEqual({})
  })
})
