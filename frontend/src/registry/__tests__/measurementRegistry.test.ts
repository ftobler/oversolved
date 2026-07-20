import { describe, it, expect } from 'vitest'
import type { LineSegment, Arc, Circle, PointEntity } from '@/types/cad'
import {
  measureSingleEntity,
  measurePair,
  measurePointToPlane,
  measurePlanes,
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
