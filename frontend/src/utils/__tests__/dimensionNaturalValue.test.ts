import { describe, it, expect } from 'vitest'
import {
  computeNaturalDimensionValue,
  resolveDimPoints,
  computeAnchorRelativePos,
  computeDimensionSign,
  linearDimensionSign,
  lineDistanceSign,
  angleDimensionSign,
} from '@/utils/geometry/dimensionNaturalValue'
import type { Sketch } from '@/types/cad'

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

  it('returns null when the render is not a two-point linear dim (e.g. angle)', () => {
    const sk = makeSketch()
    // An angle render resolves but is not dim_linear/radius/diameter -> null.
    expect(resolveDimPoints('angle', ['entity:S1:L1', 'entity:S1:L2'], sk, FID)).toBeNull()
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
