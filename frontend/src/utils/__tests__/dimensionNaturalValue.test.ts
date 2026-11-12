import { describe, it, expect } from 'vitest'
import {
  computeNaturalDimensionValue,
  resolveDimPoints,
  computeAnchorRelativePos,
  computeDimensionSign,
  computeAnglePlacementIsSupplement,
  angleStoredValue,
  linearDimensionSign,
  lineDistanceSign,
  angleDimensionSign,
} from '@/utils/geometry/dimensionNaturalValue'
import { computeAngleDimension } from '@/utils/geometry/angleDimensionLogic'
import type { PartConstraint, Sketch } from '@/types/cad'

const FID = 'S1'

function makeSketch(): Sketch {
  return {
    L1: { start: [0, 0], end: [10, 0] },        // horizontal length 10
    L2: { start: [0, 0], end: [0, 5] },         // vertical length 5
    L3: { start: [0, 0], end: [3, 4] },         // length 5, 36.87 deg from L1
    C1: { center: [0, 0], radius: 7 },          // circle r=7, d=14
    A1: { start: [5, 0], end: [0, 5], center: [0, 0], radius: 5 },  // arc r=5
    P1: { x: 2, y: 0 } as unknown as Sketch[string],
    P2: { x: 5, y: 4 } as unknown as Sketch[string],
    P3: { x: 5, y: -4 } as unknown as Sketch[string],  // below L1 (negative perpendicular side)
  } as Sketch
}

describe('computeNaturalDimensionValue', () => {
  it('length: distance between line endpoints', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('length', ['entity:S1:L1'], sk, FID)).toBe(10)
    expect(computeNaturalDimensionValue('length', ['entity:S1:L3'], sk, FID)).toBe(5)
  })

  it('radius: arc radius', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('radius', ['entity:S1:A1'], sk, FID)).toBe(5)
  })

  it('diameter: 2 * circle radius', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('diameter', ['entity:S1:C1'], sk, FID)).toBe(14)
  })

  it('line_distance: the point-first order reads the same dimension', () => {
    const sk = makeSketch()
    // P2 (5,4) onto L1 (horizontal y=0) -> distance 4, whichever side of the
    // pair the pick landed on.
    expect(computeNaturalDimensionValue(
      'line_distance', ['vertex:S1:P2', 'entity:S1:L1'], sk, FID,
    )).toBe(4)
  })

  it('point_distance: distance between two points', () => {
    const sk = makeSketch()
    // P1 (2,0), P2 (5,4) -> hypot(3,4) = 5
    const v = computeNaturalDimensionValue(
      'point_distance',
      ['vertex:S1:P1', 'vertex:S1:P2'],
      sk, FID,
    )
    expect(v).toBe(5)
  })

  it('line_distance: perpendicular point-to-line distance', () => {
    const sk = makeSketch()
    // P2 (5,4) onto L1 (horizontal y=0) -> distance 4
    const v = computeNaturalDimensionValue(
      'line_distance',
      ['entity:S1:L1', 'vertex:S1:P2'],
      sk, FID,
    )
    expect(v).toBe(4)
  })

  it('angle: signed angle between two line directions, in degrees', () => {
    const sk = makeSketch()
    // L1 horizontal, L2 vertical -> 90 deg
    const v = computeNaturalDimensionValue(
      'angle',
      ['entity:S1:L1', 'entity:S1:L2'],
      sk, FID,
    )
    expect(v).toBeCloseTo(90, 6)
  })

  it('returns null for unresolvable geometry', () => {
    const sk = makeSketch()
    // Missing entity should return null (computeConstraintRender -> 'unknown')
    expect(computeNaturalDimensionValue(
      'length', ['entity:S1:NX'], sk, FID,
    )).toBeNull()
  })

  it('point_distance_x from @builtin_origin measures the offset from the local origin', () => {
    const sk = makeSketch()
    // P1 sits at x=2; the document origin is at x=5 on this face, so the
    // dialog pre-fills 3 rather than the distance from the plane's own origin.
    expect(computeNaturalDimensionValue(
      'point_distance_x', ['@builtin_origin', 'vertex:S1:P1'], sk, FID, [5, -2],
    )).toBe(3)
  })

  it('point_distance_x from @builtin_origin defaults to a builtin plane origin', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue(
      'point_distance_x', ['@builtin_origin', 'vertex:S1:P1'], sk, FID,
    )).toBe(2)
  })
})

describe('resolveDimPoints', () => {
  it('returns null when fewer than two targets are given', () => {
    const sk = makeSketch()
    expect(resolveDimPoints('point_distance', ['vertex:S1:P1'], sk, FID)).toBeNull()
  })

  it('resolves the two endpoints of a point_distance dimension', () => {
    const sk = makeSketch()
    // P1 (2,0), P2 (5,4) -> the render's p1/p2 are these two points.
    const pts = resolveDimPoints('point_distance', ['vertex:S1:P1', 'vertex:S1:P2'], sk, FID)
    expect(pts).not.toBeNull()
    const [pa, pb] = pts!
    expect(new Set([pa.join(','), pb.join(',')])).toEqual(new Set(['2,0', '5,4']))
  })

  it('resolves a point_distance against the local origin so the placement click can orient it', () => {
    const sk = makeSketch()
    // The dimension tool reads these endpoints to pick the X/Y/euclidean variant
    // from the placement direction; the origin end must be its local point.
    expect(resolveDimPoints(
      'point_distance', ['@builtin_origin', 'vertex:S1:P1'], sk, FID, [5, -2],
    )).toEqual([[5, -2], [2, 0]])
  })

  it('returns null when the render is not a two-point linear dim (e.g. angle)', () => {
    const sk = makeSketch()
    // An angle render resolves but is not dim_linear/radius/diameter -> null.
    expect(resolveDimPoints('angle', ['entity:S1:L1', 'entity:S1:L2'], sk, FID)).toBeNull()
  })
})

describe('computeAnglePlacementIsSupplement', () => {
  // L1 along +x (0 deg), L2 along +y (90 deg), crossing at the origin. The two
  // theta wedges subtend the 90 deg; placing the label off them subtends the
  // supplement (here also 90, but the wedge identity is what matters: the
  // creation prompt must show 180 - theta there to match the live preview).
  const ANGLE = ['entity:S1:L1', 'entity:S1:L2']

  it('is false for a label in a theta quadrant (between +x and +y)', () => {
    const sk = makeSketch()
    expect(computeAnglePlacementIsSupplement(ANGLE, sk, FID, [4, 4])).toBe(false)
  })

  it('is true for a label dragged into a supplement quadrant (+x / -y)', () => {
    const sk = makeSketch()
    expect(computeAnglePlacementIsSupplement(ANGLE, sk, FID, [4, -4])).toBe(true)
  })

  it('is false without a placement point or for non-angle geometry', () => {
    const sk = makeSketch()
    expect(computeAnglePlacementIsSupplement(ANGLE, sk, FID, null)).toBe(false)
    expect(computeAnglePlacementIsSupplement(['entity:S1:NX', 'entity:S1:L2'], sk, FID, [4, -4])).toBe(false)
  })
})

describe('angleStoredValue', () => {
  // The bug-1 trapezoid corner: l1 runs +x, l2 turns up-left at 135 degrees, so
  // the stored direction angle is 135 and the corner drawn inside the slot is
  // its supplement, 45. The vertex is (6.5, 0).
  const TRAPEZOID: Sketch = {
    l1: { start: [2.5, 0], end: [6.5, 0] },
    l2: { start: [6.5, 0], end: [6, 0.5] },
  } as unknown as Sketch
  const TRAPEZOID_ANGLE: PartConstraint = { id: 'a', kind: 'angle', a: '$l1', b: '$l2' }
  const supplementWedge = (): [number, number] => [Math.cos(157.5 * Math.PI / 180) * 2, Math.sin(157.5 * Math.PI / 180) * 2]
  const thetaWedge = (): [number, number] => [Math.cos(67.5 * Math.PI / 180) * 2, Math.sin(67.5 * Math.PI / 180) * 2]

  it('a fresh 45 on the 135 corner stores 135 and places the label in a supplement wedge', () => {
    const aligned = angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 45, sketch: TRAPEZOID, newLabel: true,
    })
    expect(aligned).not.toBeNull()
    expect(aligned!.theta).toBeCloseTo(135, 9)
    const geo = computeAngleDimension([2.5, 0], [6.5, 0], [6.5, 0], [6, 0.5], aligned!.pos)
    expect(geo.isSupplement).toBe(true)
    // The label sits in the wedge nearest the drawn corner, not on the far side
    // of the crossing.
    expect(geo.labelAngleDeg).toBeCloseTo(157.5, 6)
  })

  it('a fresh 135 on the same corner stores 135 with no label offset', () => {
    const aligned = angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 135, sketch: TRAPEZOID, newLabel: true,
    })
    expect(aligned!.theta).toBe(135)
    expect(aligned!.pos).toBeUndefined()
  })

  it('a θ-wedge label makes 45 store 45, and a supplement-wedge label makes it store 135', () => {
    expect(angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 45, sketch: TRAPEZOID, pos: thetaWedge(),
    })!.theta).toBeCloseTo(45, 9)
    expect(angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 45, sketch: TRAPEZOID, pos: supplementWedge(),
    })!.theta).toBeCloseTo(135, 9)
  })

  it('an existing label with no pos reads the renderer default wedge', () => {
    // The trapezoid corner's default label falls in the supplement wedge, so the
    // number shown there is 45; an edit to 45 must keep theta 135, and an edit to
    // 135 must store 45 because the label then shows 135.
    expect(angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 45, sketch: TRAPEZOID,
    })!.theta).toBeCloseTo(135, 9)
    expect(angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 135, sketch: TRAPEZOID,
    })!.theta).toBeCloseTo(45, 9)
  })

  it('a fresh supplement value on a theta-wedge corner places the label nearest the drawing', () => {
    // Both lines start at the origin, 30 degrees apart, so the default label is
    // in the theta wedge. A typed 150 names the supplement; the nearer of the two
    // supplement wedges bisects at 105.
    const sketch: Sketch = {
      a: { start: [0, 0], end: [10, 0] },
      b: { start: [0, 0], end: [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)] },
    } as unknown as Sketch
    const aligned = angleStoredValue({
      constraint: { id: 'a', kind: 'angle', a: '$a', b: '$b' },
      value: 150, sketch, newLabel: true,
    })
    expect(aligned!.theta).toBeCloseTo(30, 6)
    const geo = computeAngleDimension(
      [0, 0], [10, 0], [0, 0], [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)], aligned!.pos,
    )
    expect(geo.isSupplement).toBe(true)
    expect(geo.labelAngleDeg).toBeCloseTo(105, 6)
  })

  it('a tie keeps the drawn theta: a right corner and a 90 value', () => {
    const sketch: Sketch = {
      a: { start: [0, 0], end: [10, 0] },
      b: { start: [0, 0], end: [0, 10] },
    } as unknown as Sketch
    const aligned = angleStoredValue({
      constraint: { id: 'a', kind: 'angle', a: '$a', b: '$b' },
      value: 90, sketch, newLabel: true,
    })
    expect(aligned!.theta).toBe(90)
    expect(aligned!.pos).toBeUndefined()
  })

  it('returns null when the operands are not two resolvable lines', () => {
    expect(angleStoredValue({
      constraint: { id: 'a', kind: 'angle', a: '$l1' }, value: 45, sketch: TRAPEZOID, newLabel: true,
    })).toBeNull()
  })

  it('treats a non-finite pos as no pos and reads the default wedge', () => {
    const aligned = angleStoredValue({
      constraint: TRAPEZOID_ANGLE, value: 45, sketch: TRAPEZOID, pos: [NaN, 0],
    })
    expect(aligned!.theta).toBeCloseTo(135, 9)
  })
})

describe('computeAnchorRelativePos', () => {
  it('dim_radius: anchor is the center (p1)', () => {
    const sk = makeSketch()
    // A1 center (0,0); world placement maps straight to a relative offset.
    expect(computeAnchorRelativePos('radius', ['entity:S1:A1'], sk, FID, [3, 7]))
      .toEqual([3, 7])
  })

  it('dim_linear: anchor is the midpoint of p1,p2', () => {
    const sk = makeSketch()
    // L1 (0,0)->(10,0); midpoint (5,0); world (5,3) -> (0,3).
    expect(computeAnchorRelativePos('length', ['entity:S1:L1'], sk, FID, [5, 3]))
      .toEqual([0, 3])
  })

  it('dim_diameter: anchor is the circle center (midpoint of the through-line)', () => {
    const sk = makeSketch()
    // C1 center (0,0); diameter endpoints are symmetric so the midpoint is the center.
    expect(computeAnchorRelativePos('diameter', ['entity:S1:C1'], sk, FID, [1, 2]))
      .toEqual([1, 2])
  })

  it('dim_angle: anchor is the two lines intersection vertex', () => {
    const sk = makeSketch()
    // L1 and L2 both start at the origin, so the vertex is (0,0).
    expect(computeAnchorRelativePos('angle', ['entity:S1:L1', 'entity:S1:L2'], sk, FID, [4, 5]))
      .toEqual([4, 5])
  })

  it('returns null for unresolvable geometry', () => {
    const sk = makeSketch()
    expect(computeAnchorRelativePos('length', ['entity:S1:NX'], sk, FID, [0, 0])).toBeNull()
  })
})

describe('computeDimensionSign', () => {
  it('point_distance_x: +1 when b is right of a, -1 when left', () => {
    const sk = makeSketch()  // P1 (2,0), P2 (5,4)
    expect(computeDimensionSign('point_distance_x', ['vertex:S1:P1', 'vertex:S1:P2'], sk, FID)).toBe(1)
    expect(computeDimensionSign('point_distance_x', ['vertex:S1:P2', 'vertex:S1:P1'], sk, FID)).toBe(-1)
  })

  it('point_distance_y: +1 when b is above a, -1 when below', () => {
    const sk = makeSketch()
    expect(computeDimensionSign('point_distance_y', ['vertex:S1:P1', 'vertex:S1:P2'], sk, FID)).toBe(1)
    expect(computeDimensionSign('point_distance_y', ['vertex:S1:P2', 'vertex:S1:P1'], sk, FID)).toBe(-1)
  })

  it('angle: handedness follows the directed cross product, flips with operand order', () => {
    const sk = makeSketch()  // L1 +x, L3 into the first quadrant -> cross > 0
    expect(computeDimensionSign('angle', ['entity:S1:L1', 'entity:S1:L3'], sk, FID)).toBe(1)
    expect(computeDimensionSign('angle', ['entity:S1:L3', 'entity:S1:L1'], sk, FID)).toBe(-1)
  })

  it('line_distance: +1 when the point is on the +normal side of the line, -1 below', () => {
    const sk = makeSketch()  // L1 horizontal (y=0); P2 above (y=4), P3 below (y=-4)
    expect(computeDimensionSign('line_distance', ['entity:S1:L1', 'vertex:S1:P2'], sk, FID)).toBe(1)
    expect(computeDimensionSign('line_distance', ['entity:S1:L1', 'vertex:S1:P3'], sk, FID)).toBe(-1)
  })

  it('line_distance: a point-first pick measures and signs the same side', () => {
    const sk = makeSketch()
    // Point-first is the order a mixed click can produce. The canonicaliser
    // stores line-first, so the sign must already read the same here.
    expect(computeDimensionSign('line_distance', ['vertex:S1:P2', 'entity:S1:L1'], sk, FID)).toBe(1)
    expect(computeDimensionSign('line_distance', ['vertex:S1:P3', 'entity:S1:L1'], sk, FID)).toBe(-1)
  })

  it('point_distance_x: an origin operand signs against the local origin', () => {
    const sk = makeSketch()  // P1 (2,0); the face origin is (5,-2)
    // P1 is 3 to the -x side of the face origin, so a dimension from the
    // origin to P1 must pin the negative side and stop the solver flipping it.
    // Before the origin was threaded this render was unknown and the sign null.
    expect(computeDimensionSign(
      'point_distance_x', ['@builtin_origin', 'vertex:S1:P1'], sk, FID, [5, -2],
    )).toBe(-1)
    expect(computeDimensionSign(
      'point_distance_x', ['vertex:S1:P1', '@builtin_origin'], sk, FID, [5, -2],
    )).toBe(1)
  })

  it('returns null for non-directional dimension kinds', () => {
    const sk = makeSketch()
    expect(computeDimensionSign('length', ['entity:S1:L1'], sk, FID)).toBeNull()
    expect(computeDimensionSign('radius', ['entity:S1:A1'], sk, FID)).toBeNull()
    expect(computeDimensionSign('point_distance', ['vertex:S1:P1', 'vertex:S1:P2'], sk, FID)).toBeNull()
  })
})

describe('pure sign helpers (used by the live flip button)', () => {
  it('linearDimensionSign reads the signed gap on the relevant axis', () => {
    expect(linearDimensionSign('point_distance_x', [0, 0], [5, 9])).toBe(1)
    expect(linearDimensionSign('point_distance_x', [5, 9], [0, 0])).toBe(-1)
    expect(linearDimensionSign('point_distance_y', [0, 0], [9, 5])).toBe(1)
    expect(linearDimensionSign('point_distance_y', [0, 5], [9, 0])).toBe(-1)
  })

  it('angleDimensionSign reads the directed cross of the two line directions', () => {
    // dirA +x, dirB +y -> cross > 0
    expect(angleDimensionSign([0, 0], [1, 0], [0, 0], [0, 1])).toBe(1)
    // dirB -y -> cross < 0
    expect(angleDimensionSign([0, 0], [1, 0], [0, 0], [0, -1])).toBe(-1)
  })

  it('lineDistanceSign reads the signed perpendicular offset (p1=foot, p2=point)', () => {
    // Horizontal line direction `normal` = [1,0] -> perpDir = [0,1].
    expect(lineDistanceSign([5, 0], [5, 4], [1, 0])).toBe(1)
    expect(lineDistanceSign([5, 0], [5, -4], [1, 0])).toBe(-1)
    // Vertical line direction `normal` = [0,1] -> perpDir = [-1,0].
    expect(lineDistanceSign([0, 5], [-4, 5], [0, 1])).toBe(1)
    expect(lineDistanceSign([0, 5], [4, 5], [0, 1])).toBe(-1)
  })
})
