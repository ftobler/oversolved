import { describe, it, expect } from 'vitest'
import { computeConstraintRender, deriveConstraints } from '@/utils/geometry/geometryMapping'
import type { Sketch, PartConstraint, SymbolRender, DimLinearRender, SketchFeature } from '@/types/cad'

// Coverage for the per-kind branches of computeConstraintRenderCore that the
// other geometryMapping suites did not exercise: the symbol_* relational
// constraints (horizontal/vertical/coincident/normal/concentric/fixed/tangent/
// colinear/midpoint), the equal_length circle anchor, and the arc/spline arms
// of geomPoint reached through `fixed`.

function makeSketch(): Sketch {
  return {
    H1: { start: [0, 0], end: [10, 0] },                                   // horizontal line
    V1: { start: [2, 0], end: [2, 8] },                                    // vertical line
    L2: { start: [0, 4], end: [6, 4] },                                    // second line
    arc1: { center: [5, 5], radius: 3, angle_start: 0, angle_end: 90, start: [8, 5], end: [5, 8] },
    circ1: { center: [4, 4], radius: 2 },                                  // circle
    circ2: { center: [9, 9], radius: 5 },                                  // circle
    sp1: { p1: [0, 0], p2: [1, 2], p3: [3, 2], p4: [4, 0] },               // cubic spline
    PT: { x: 7, y: 1 },                                                    // point entity
    LINE_DEGEN: { start: [3, 3], end: [3, 3] },                            // zero-length line
  } as unknown as Sketch
}

describe('computeConstraintRender (horizontal / vertical)', () => {
  it('horizontal two-point form anchors at the midpoint of both points', () => {
    const c: PartConstraint = { id: 'H', kind: 'horizontal', a: '$H1', b: '$V1end' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_h')
    expect(r.at).toEqual([(0 + 2) / 2, (0 + 8) / 2])
    expect(r.entities).toEqual(['H1', 'V1'])
  })

  it('horizontal single-target form anchors at the line midpoint', () => {
    const c: PartConstraint = { id: 'H', kind: 'horizontal', target: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_h')
    expect(r.at).toEqual([5, 0])
    expect(r.entity).toBe('H1')
  })

  it('vertical two-point form anchors at the midpoint of both points', () => {
    const c: PartConstraint = { id: 'V', kind: 'vertical', a: '$V1', b: '$H1end' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_v')
    expect(r.at).toEqual([(2 + 10) / 2, (0 + 0) / 2])
  })

  it('vertical single-target form anchors at the line midpoint', () => {
    const c: PartConstraint = { id: 'V', kind: 'vertical', target: '$V1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_v')
    expect(r.at).toEqual([2, 4])
  })

  it('vertical with a non-line target falls back to a generic glyph', () => {
    const c: PartConstraint = { id: 'V', kind: 'vertical', target: '$PT' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_unknown')
    expect(r.at).toEqual([7, 1])
  })
})

describe('computeConstraintRender (coincident / colinear / midpoint)', () => {
  it('coincident anchors at the resolved point and lists both entities', () => {
    const c: PartConstraint = { id: 'C', kind: 'coincident', a: '$H1end', b: '$V1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_coincident')
    expect(r.at).toEqual([10, 0])
    expect(r.entities).toEqual(['H1', 'V1'])
  })

  it('coincident pinning a point to @builtin_origin renders as a coincident at the local point', () => {
    // The origin operand has no geometry in this sketch, but the local point does;
    // the glyph must anchor there instead of falling back to the unknown tile.
    // See bugreports/strange_residual_constraint_20260622_200230.md.
    const c: PartConstraint = { id: 'C', kind: 'coincident', a: '@builtin_origin', b: '$PT' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_coincident')
    expect(r.at).toEqual([7, 1])
    expect(r.entities).toEqual(['PT'])
  })

  it('coincident with the origin in the b slot anchors at the a point', () => {
    const c: PartConstraint = { id: 'C', kind: 'coincident', a: '$PT', b: '@builtin_origin' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_coincident')
    expect(r.at).toEqual([7, 1])
    expect(r.entities).toEqual(['PT'])
  })

  it('coincident using the target slot resolves too', () => {
    const c: PartConstraint = { id: 'C', kind: 'coincident', target: '$L2' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_coincident')
    expect(r.at).toEqual([0, 4])
  })

  it('colinear anchors at the first resolvable operand', () => {
    const c: PartConstraint = { id: 'CL', kind: 'colinear', a: '$H1', b: '$L2' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_colinear')
    expect(r.at).toEqual([0, 0])
    expect(r.entities).toEqual(['H1', 'L2'])
  })

  it('midpoint anchors at the line midpoint', () => {
    const c: PartConstraint = { id: 'M', kind: 'midpoint', line: '$H1', point: '$PT' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_midpoint')
    expect(r.at).toEqual([5, 0])
    expect(r.entities).toEqual(['H1', 'PT'])
  })

  it('midpoint without a line ref is unknown', () => {
    const c: PartConstraint = { id: 'M', kind: 'midpoint', point: '$PT' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    // fallback glyph anchors on the resolvable point operand
    expect(r.kind).toBe('symbol_unknown')
  })
})

describe('computeConstraintRender (normal)', () => {
  it('arc on the b slot anchors the glyph at the arc endpoint', () => {
    const c: PartConstraint = { id: 'N', kind: 'normal', a: '$H1', b: '$arc1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_normal')
    expect(r.at).toEqual([8, 5])  // arc1.start (b.point !== 'end')
    expect(r.entity).toBe('arc1')
  })

  it('arc on the a slot (b is a line) anchors at the arc end', () => {
    const c: PartConstraint = { id: 'N', kind: 'normal', a: '$arc1end', b: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_normal')
    expect(r.at).toEqual([5, 8])  // arc1.end (a.point === 'end')
    expect(r.entity).toBe('arc1')
  })

  it('two lines anchor the glyph at the first line end', () => {
    const c: PartConstraint = { id: 'N', kind: 'normal', a: '$H1', b: '$V1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_normal')
    expect(r.at).toEqual([10, 0])  // H1.end
  })

  it('circle on the b slot anchors at the circle center', () => {
    const c: PartConstraint = { id: 'N', kind: 'normal', a: '$H1', b: '$circ1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_normal')
    expect(r.at).toEqual([4, 4])  // circ1 center, not its AABB corner
    expect(r.entity).toBe('circ1')
  })

  it('circle on the a slot anchors at the circle center', () => {
    const c: PartConstraint = { id: 'N', kind: 'normal', a: '$circ1', b: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_normal')
    expect(r.at).toEqual([4, 4])
    expect(r.entity).toBe('circ1')
  })
})

describe('computeConstraintRender (concentric / fixed)', () => {
  it('concentric anchors at the circle center', () => {
    const c: PartConstraint = { id: 'CO', kind: 'concentric', a: '$circ1', b: '$circ2' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_concentric')
    expect(r.at).toEqual([4, 4])
    expect(r.entities).toEqual(['circ1', 'circ2'])
  })

  it('concentric anchored on a point entity uses its x/y', () => {
    const c: PartConstraint = { id: 'CO', kind: 'concentric', a: '$PT', b: '$circ1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_concentric')
    expect(r.at).toEqual([7, 1])
  })

  it('fixed anchors at the target point and carries the point sub-key', () => {
    const c: PartConstraint = { id: 'F', kind: 'fixed', target: '$H1end' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender & { point?: string }
    expect(r.kind).toBe('symbol_fixed')
    expect(r.at).toEqual([10, 0])
    expect(r.point).toBe('end')
  })
})

describe('computeConstraintRender (equal_length circle anchor)', () => {
  it('equal_length on a line anchors at the segment midpoint', () => {
    const c: PartConstraint = { id: 'EQ', kind: 'equal_length', a: '$H1', b: '$L2' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_equal')
    expect(r.at).toEqual([5, 0])
  })

  it('equal_length (equal-radius) on a circle anchors at the circle center', () => {
    const c: PartConstraint = { id: 'EQ', kind: 'equal_length', a: '$circ1', b: '$circ2' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_equal')
    expect(r.at).toEqual([4, 4])  // geomPoint on a circle -> center
  })
})

describe('computeConstraintRender (tangent)', () => {
  it('arc tangent anchors at the pinned arc endpoint', () => {
    const c: PartConstraint = { id: 'T', kind: 'tangent', a: '$arc1', b: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_tangent')
    expect(r.at).toEqual([8, 5])  // arc1.start
    expect(r.entity).toBe('arc1')
  })

  it('circle + line tangent anchors at the perpendicular foot from the center', () => {
    const c: PartConstraint = { id: 'T', kind: 'tangent', a: '$circ1', b: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_tangent')
    // foot of perpendicular from circ1.center (4,4) onto H1 (y=0) is (4,0)
    expect(r.at).toEqual([4, 0])
    expect(r.entities).toEqual(['H1', 'circ1'])
  })

  it('circle + degenerate line falls back to the line start', () => {
    const c: PartConstraint = { id: 'T', kind: 'tangent', a: '$circ1', b: '$LINE_DEGEN' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_tangent')
    expect(r.at).toEqual([3, 3])  // LINE_DEGEN.start (len2 ~ 0)
  })

  it('circle with no line falls back to the circle center', () => {
    const c: PartConstraint = { id: 'T', kind: 'tangent', a: '$circ1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_tangent')
    expect(r.at).toEqual([4, 4])
  })

  it('tangent via the explicit line/arc slots resolves the arc', () => {
    const c: PartConstraint = { id: 'T', kind: 'tangent', arc: '$arc1end', line: '$H1' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_tangent')
    expect(r.at).toEqual([5, 8])  // arc1.end
  })
})

describe('geomPoint arc / spline arms (reached through fixed)', () => {
  it('fixed on an arc center', () => {
    const c: PartConstraint = { id: 'F', kind: 'fixed', target: '$arc1center' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.at).toEqual([5, 5])
  })

  it('fixed on an arc end', () => {
    const c: PartConstraint = { id: 'F', kind: 'fixed', target: '$arc1end' }
    const r = computeConstraintRender(c, makeSketch()) as SymbolRender
    expect(r.at).toEqual([5, 8])
  })

  it('fixed on spline start / control points / end', () => {
    const sketch = makeSketch()
    expect((computeConstraintRender({ id: 'F', kind: 'fixed', target: '$sp1' }, sketch) as SymbolRender).at).toEqual([0, 0])
    expect((computeConstraintRender({ id: 'F', kind: 'fixed', target: '$sp1c1' }, sketch) as SymbolRender).at).toEqual([1, 2])
    expect((computeConstraintRender({ id: 'F', kind: 'fixed', target: '$sp1c2' }, sketch) as SymbolRender).at).toEqual([3, 2])
    expect((computeConstraintRender({ id: 'F', kind: 'fixed', target: '$sp1end' }, sketch) as SymbolRender).at).toEqual([4, 0])
  })
})

describe('computeConstraintRender (genuinely unresolvable)', () => {
  it('an unknown kind with no resolvable operand is unknown', () => {
    const c: PartConstraint = { id: 'X', kind: 'totally_made_up', a: '$does_not_exist' }
    const r = computeConstraintRender(c, makeSketch())
    expect(r.kind).toBe('unknown')
  })

  it('horizontal with no refs at all is unknown', () => {
    const c: PartConstraint = { id: 'H', kind: 'horizontal' }
    const r = computeConstraintRender(c, makeSketch())
    expect(r.kind).toBe('unknown')
  })
})

describe('computeConstraintRender (dim pos propagation)', () => {
  it('length carries pos through to the dim render', () => {
    const c: PartConstraint = { id: 'L', kind: 'length', target: '$H1', value: 10, pos: [1, 2] }
    const r = computeConstraintRender(c, makeSketch()) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.pos).toEqual([1, 2])
  })
})

describe('computeConstraintRender (directional linear dims tag their dimKind)', () => {
  // The render kind is always 'dim_linear', so the renderer relies on `dimKind`
  // to know a linear dim is directional (and which sign convention) for the
  // "Flip side" button. Non-directional length must leave it unset.
  it('point_distance_x / point_distance_y / line_distance carry dimKind', () => {
    const sk = makeSketch()
    const px = computeConstraintRender(
      { id: 'a', kind: 'point_distance_x', a: '$PT', b: '$circ1', value: 1 }, sk,
    ) as DimLinearRender
    expect(px.dimKind).toBe('point_distance_x')
    const py = computeConstraintRender(
      { id: 'b', kind: 'point_distance_y', a: '$PT', b: '$circ1', value: 1 }, sk,
    ) as DimLinearRender
    expect(py.dimKind).toBe('point_distance_y')
    const ld = computeConstraintRender(
      { id: 'c', kind: 'line_distance', a: '$H1', b: '$PT', value: 1 }, sk,
    ) as DimLinearRender
    expect(ld.dimKind).toBe('line_distance')
  })

  it('non-directional length leaves dimKind unset', () => {
    const r = computeConstraintRender(
      { id: 'L', kind: 'length', target: '$H1', value: 10 }, makeSketch(),
    ) as DimLinearRender
    expect(r.dimKind).toBeUndefined()
  })

  it('the zero-legal kinds carry dimKind for the edit dialog value rule', () => {
    const sk = makeSketch()
    const pd = computeConstraintRender(
      { id: 'd', kind: 'point_distance', a: '$PT', b: '$circ1', value: 1 }, sk,
    ) as DimLinearRender
    expect(pd.dimKind).toBe('point_distance')
    const rd = computeConstraintRender(
      { id: 'e', kind: 'radius_difference', a: '$circ1', b: '$circ2', value: 1 }, sk,
    ) as DimLinearRender
    expect(rd.dimKind).toBe('radius_difference')
  })
})

describe('computeConstraintRender (dimensions against @builtin_origin)', () => {
  // The origin is not a sketch entity, so it arrives through the render context
  // in the sketch's local frame. On a builtin plane that is [0,0]; on a face or
  // an offset plane it is nonzero and only the caller knows it.
  const FACE_ORIGIN: [number, number] = [5, -2]

  const originDist = (kind: string, a: string, b: string): PartConstraint => ({
    id: 'D', kind, a, b, value: 3,
  })

  it('point_distance_x renders the origin end and anchors on the sketch operand', () => {
    const r = computeConstraintRender(
      originDist('point_distance_x', '@builtin_origin', '$PT'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.dimKind).toBe('point_distance_x')
    expect(r.p1).toEqual([5, -0.5])
    expect(r.p2).toEqual([7, -0.5])
    // The origin is not an entity; pick and hover key on the other operand.
    expect(r.entity).toBe('PT')
  })

  it('point_distance_x renders with the origin in the b slot', () => {
    const r = computeConstraintRender(
      originDist('point_distance_x', '$PT', '@builtin_origin'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.p1).toEqual([7, -0.5])
    expect(r.p2).toEqual([5, -0.5])
    expect(r.entity).toBe('PT')
  })

  it('point_distance_y renders the origin end', () => {
    const r = computeConstraintRender(
      originDist('point_distance_y', '@builtin_origin', '$PT'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.dimKind).toBe('point_distance_y')
    expect(r.p1).toEqual([6, -2])
    expect(r.p2).toEqual([6, 1])
    expect(r.entity).toBe('PT')
  })

  it('point_distance renders the euclidean distance from the origin', () => {
    const r = computeConstraintRender(
      originDist('point_distance', '@builtin_origin', '$PT'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.dimKind).toBe('point_distance')
    expect(r.p1).toEqual([5, -2])
    expect(r.p2).toEqual([7, 1])
    expect(r.entity).toBe('PT')
  })

  it('line_distance accepts the origin as the point operand in either slot', () => {
    const pointFirst = computeConstraintRender(
      originDist('line_distance', '@builtin_origin', '$H1'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    const lineFirst = computeConstraintRender(
      originDist('line_distance', '$H1', '@builtin_origin'),
      makeSketch(),
      { originLocal: FACE_ORIGIN },
    ) as DimLinearRender
    for (const r of [pointFirst, lineFirst]) {
      expect(r.kind).toBe('dim_linear')
      expect(r.dimKind).toBe('line_distance')
      expect(r.p1).toEqual([5, 0])
      expect(r.p2).toEqual([5, -2])
      expect(r.entity).toBe('H1')
    }
  })

  it('defaults the origin to [0,0] for a builtin plane', () => {
    const r = computeConstraintRender(
      originDist('point_distance_x', '@builtin_origin', '$PT'),
      makeSketch(),
    ) as DimLinearRender
    expect(r.kind).toBe('dim_linear')
    expect(r.p1).toEqual([0, 0.5])
    expect(r.p2).toEqual([7, 0.5])
  })

  it('deriveConstraints keeps the id and kind with an origin operand', () => {
    const c = originDist('point_distance_x', '@builtin_origin', '$PT')
    const feature = { id: 'sk1', kind: 'sketch', constraints: [c] } as unknown as SketchFeature
    const map = deriveConstraints(feature, makeSketch(), { originLocal: FACE_ORIGIN })
    expect(Object.keys(map)).toEqual([c.id])
    const render = map[c.id].render as DimLinearRender
    expect(render.kind).toBe('dim_linear')
    expect(render.dimKind).toBe('point_distance_x')
  })
})
