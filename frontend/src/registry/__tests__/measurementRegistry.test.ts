import { describe, it, expect } from 'vitest'
import type { BodyResult, EdgeDataLine, LineSegment, Arc, Circle, PointEntity } from '@/types/cad'
import {
  measureSingleEntity,
  measurePair,
  measurePointToPlane,
  measurePlanes,
  measure3dSelection,
  type Plane3D,
} from '@/registry/measurementRegistry'

// Fixtures. Arc carries start/end (required by the type) even where the
// measurement only reads center/radius/angles.
const circle = (cx: number, cy: number, r: number): Circle => ({ center: [cx, cy], radius: r })
const line = (x0: number, y0: number, x1: number, y1: number): LineSegment => ({
  start: [x0, y0],
  end: [x1, y1],
})
const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Arc => ({
  center: [cx, cy],
  radius: r,
  angle_start: a0,
  angle_end: a1,
  start: [cx + r, cy],
  end: [cx + r, cy],
})
const point = (x: number, y: number): PointEntity => ({ x, y })

describe('measureSingleEntity', () => {
  it('reports circle diameter as 2*radius', () => {
    expect(measureSingleEntity(circle(0, 0, 2.5))).toEqual(['[CIRCLE] d=5.000 mm'])
  })

  it('reports arc radius and sweep in degrees', () => {
    // Quarter turn (pi/2) -> 90 degrees.
    expect(measureSingleEntity(arc(0, 0, 3, 0, Math.PI / 2))).toEqual(['[ARC] r=3.000 mm, θ=90°'])
  })

  it('reports line length via hypot', () => {
    // 3-4-5 triangle -> length 5.
    expect(measureSingleEntity(line(0, 0, 3, 4))).toEqual(['[LINE] 5.000 mm'])
  })

  it('returns no measurement for a bare point', () => {
    expect(measureSingleEntity(point(1, 2))).toEqual([])
  })

  it('does not mistake an arc for a circle (angle_start disambiguates)', () => {
    // An arc has center+radius like a circle, but its angle_start must route it
    // to the arc rule, not the circle rule.
    const result = measureSingleEntity(arc(0, 0, 3, 0, Math.PI))
    expect(result[0]?.startsWith('[ARC]')).toBe(true)
  })
})

describe('measurePair', () => {
  it('measures perpendicular point-to-line distance', () => {
    // Horizontal segment on y=0; point at (1,2) -> foot at (1,0), distance 2.
    expect(measurePair({ line1: line(0, 0, 4, 0), point1: point(1, 2) })).toEqual([
      'point-line distance: 2.000 mm',
    ])
  })

  it('clamps the point-to-line foot to the segment endpoints', () => {
    // Point is beyond the far endpoint (4,0); clamped foot is (4,0), so the
    // distance is to that endpoint: hypot(6-4, 0) = 2.
    expect(measurePair({ line1: line(0, 0, 4, 0), point1: point(6, 0) })).toEqual([
      'point-line distance: 2.000 mm',
    ])
  })

  it('reports the acute angle between two lines', () => {
    // Horizontal vs a line at 135 degrees -> reported as the acute 45.
    expect(measurePair({ line1: line(0, 0, 1, 0), line2: line(0, 0, -1, 1) })).toEqual([
      'angle: 45.0°',
    ])
  })

  it('reports parallel-line separation instead of an angle', () => {
    // y=0 and y=3, both horizontal -> parallel, distance 3.
    expect(measurePair({ line1: line(0, 0, 5, 0), line2: line(0, 3, 5, 3) })).toEqual([
      'parallel lines, distance: 3.000 mm',
    ])
  })

  it('pins the 2D parallel threshold: just inside the raw cross-product eps still reads as parallel', () => {
    // Unit-length line1 along +X; line2 is offset to y=3 and tilted so its raw
    // (non-normalized) cross product with line1 is 9e-7, just under the 1e-6
    // LINE_PAIR_PARALLEL_CROSS_EPS threshold. Distance only depends on the
    // lines' start points here, so it stays a clean 3.
    expect(measurePair({ line1: line(0, 0, 1, 0), line2: line(0, 3, 1, 3 + 9e-7) })).toEqual([
      'parallel lines, distance: 3.000 mm',
    ])
  })

  it('pins the 2D parallel threshold: just outside the raw cross-product eps reads as an angle', () => {
    // Same construction, tilted so the raw cross product is 1.1e-6, just over
    // the threshold -- this must fall through to the angle branch, not the
    // parallel one, even though the angle itself rounds to 0.0 degrees.
    expect(measurePair({ line1: line(0, 0, 1, 0), line2: line(0, 3, 1, 3 + 1.1e-6) })).toEqual([
      'angle: 0.0°',
    ])
  })

  it('measures circle-circle center distance', () => {
    expect(measurePair({ circle1: circle(0, 0, 1), circle2: circle(3, 4, 1) })).toEqual([
      'center dist: 5.000 mm',
    ])
  })

  it('measures point-point distance above the noise floor', () => {
    expect(measurePair({ point1: point(0, 0), point2: point(3, 4) })).toEqual(['dist: 5.000 mm'])
  })

  it('suppresses point-point distance at or below 0.010 mm', () => {
    expect(measurePair({ point1: point(0, 0), point2: point(0.005, 0) })).toEqual([])
  })

  it('first matching rule wins: line+point hits point-to-line before any later rule', () => {
    const result = measurePair({ line1: line(0, 0, 4, 0), point1: point(2, 1) })
    expect(result[0]?.startsWith('point-line distance')).toBe(true)
  })

  it('returns nothing when no rule matches the given combination', () => {
    expect(measurePair({ point1: point(0, 0) })).toEqual([])
  })
})

describe('measurePointToPlane', () => {
  it('measures perpendicular distance from a sketch point to a plane', () => {
    // Plane z=5 (normal +Z) measured against a sketch point (which sits at z=0)
    // -> distance 5.
    const plane: Plane3D = {
      origin: [0, 0, 5],
      normal: [0, 0, 1],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
    }
    expect(measurePointToPlane(point(2, 3), plane)).toEqual(['plane distance: 5.000 mm'])
  })
})

describe('measurePlanes', () => {
  const xy = (z: number): Plane3D => ({
    origin: [0, 0, z],
    normal: [0, 0, 1],
    x_axis: [1, 0, 0],
    y_axis: [0, 1, 0],
  })

  it('measures distance between parallel planes', () => {
    expect(measurePlanes(xy(0), xy(7))).toEqual(['plane distance: 7.000 mm'])
  })

  it('treats anti-parallel normals as parallel', () => {
    const flipped: Plane3D = { origin: [0, 0, 4], normal: [0, 0, -1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }
    expect(measurePlanes(xy(0), flipped)).toEqual(['plane distance: 4.000 mm'])
  })

  it('returns no measurement for non-parallel planes', () => {
    const xz: Plane3D = { origin: [0, 0, 0], normal: [0, 1, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1] }
    expect(measurePlanes(xy(0), xz)).toEqual([])
  })
})

describe('measure3dSelection: edge-pair parallel threshold', () => {
  // Two line edges on one body, addressed via the "@bodyId/edge/N" fallback
  // query format that findBodyElement understands. edgeA runs along +X;
  // edgeB is tilted by `theta` radians in the XY plane and offset to y=3, so
  // (for these unit-length directions) the acos-of-normalized-dot angle the
  // code computes comes out to exactly `theta`, and the perpendicular
  // distance in the parallel branch depends only on the y=3 offset, not on
  // theta -- both make the threshold easy to pin precisely.
  const edgeLine = (
    start: [number, number, number],
    end: [number, number, number]
  ): EdgeDataLine => ({ kind: 'line', start, end })

  const bodyWithEdges = (edgeA: EdgeDataLine, edgeB: EdgeDataLine): Record<string, BodyResult> => ({
    b1: { id: 'b1', created_by: '', modified_by: [], edges: [edgeA, edgeB] },
  })

  const ids = new Set(['@b1/edge/0', '@b1/edge/1'])

  it('pins the 3D parallel threshold: just inside the angle eps still reads as parallel', () => {
    const theta = 9e-5  // < EDGE_PAIR_PARALLEL_ANGLE_EPS_RAD (1e-4)
    const edgeA = edgeLine([0, 0, 0], [1, 0, 0])
    const edgeB = edgeLine([0, 3, 0], [Math.cos(theta), 3 + Math.sin(theta), 0])
    expect(measure3dSelection(ids, bodyWithEdges(edgeA, edgeB))).toEqual([
      'parallel edges, distance: 3.000 mm',
    ])
  })

  it('pins the 3D parallel threshold: just outside the angle eps reads as an edge angle', () => {
    const theta = 1.1e-4  // > EDGE_PAIR_PARALLEL_ANGLE_EPS_RAD (1e-4)
    const edgeA = edgeLine([0, 0, 0], [1, 0, 0])
    const edgeB = edgeLine([0, 3, 0], [Math.cos(theta), 3 + Math.sin(theta), 0])
    expect(measure3dSelection(ids, bodyWithEdges(edgeA, edgeB))).toEqual(['edge angle: 0.0°'])
  })
})
