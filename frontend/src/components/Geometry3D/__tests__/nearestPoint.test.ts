import { describe, it, expect } from 'vitest'
import { nearestPointOnLine, nearestPointOnCircle, nearestPointOnArc, nearestPointOnEntity } from '@/components/Geometry3D/nearestPoint'
import type { LineSegment, Circle, Arc, PointEntity } from '@/types/cad'

describe('nearestPointOnLine', () => {
  it('returns nearest point when projection falls within segment', () => {
    const result = nearestPointOnLine(5, 5, 0, 0, 10, 0)
    expect(result.position).toEqual([5, 0])
    expect(result.distance).toBeCloseTo(5)
  })

  it('returns start point when projection is before start', () => {
    const result = nearestPointOnLine(-5, 5, 0, 0, 10, 0)
    expect(result.position).toEqual([0, 0])
    expect(result.distance).toBeCloseTo(Math.hypot(5, 5))
  })

  it('returns end point when projection is after end', () => {
    const result = nearestPointOnLine(15, 5, 0, 0, 10, 0)
    expect(result.position).toEqual([10, 0])
    expect(result.distance).toBeCloseTo(Math.hypot(5, 5))
  })

  it('handles zero-length line', () => {
    const result = nearestPointOnLine(5, 5, 3, 3, 3, 3)
    expect(result.position).toEqual([3, 3])
    expect(result.distance).toBeCloseTo(Math.hypot(2, 2))
  })

  it('works with vertical lines', () => {
    const result = nearestPointOnLine(5, 5, 0, 0, 0, 10)
    expect(result.position).toEqual([0, 5])
    expect(result.distance).toBeCloseTo(5)
  })

  it('returns exact point when already on line', () => {
    const result = nearestPointOnLine(5, 0, 0, 0, 10, 0)
    expect(result.position).toEqual([5, 0])
    expect(result.distance).toBeCloseTo(0)
  })
})

describe('nearestPointOnCircle', () => {
  it('returns nearest point on circumference', () => {
    const result = nearestPointOnCircle(5, 0, 0, 0, 10)
    expect(result.position).toEqual([10, 0])
    expect(result.distance).toBeCloseTo(5)
  })

  it('returns nearest point for point inside circle', () => {
    const result = nearestPointOnCircle(0, 0, 0, 0, 10)
    expect(result.position).toEqual([10, 0])
    expect(result.distance).toBeCloseTo(10)
  })

  it('returns nearest point for point outside circle', () => {
    const result = nearestPointOnCircle(20, 10, 0, 0, 10)
    expect(result.position[0]).toBeCloseTo(8.94, 1)
    expect(result.position[1]).toBeCloseTo(4.47, 1)
    expect(result.distance).toBeCloseTo(Math.hypot(20 - result.position[0], 10 - result.position[1]))
  })

  it('reports a non-negative distance for points all around the circle', () => {
    // The distance is a bare Math.hypot, which is never negative, so no
    // Math.abs wrapper is needed. Sweep points inside, on, and outside.
    for (let deg = 0; deg < 360; deg += 30) {
      for (const radius of [0, 5, 10, 25]) {
        const a = (deg * Math.PI) / 180
        const result = nearestPointOnCircle(radius * Math.cos(a), radius * Math.sin(a), 0, 0, 10)
        expect(result.distance).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('returns exact point on circumference', () => {
    const result = nearestPointOnCircle(10, 0, 0, 0, 10)
    expect(result.position).toEqual([10, 0])
    expect(result.distance).toBeCloseTo(0)
  })
})

describe('nearestPointOnArc', () => {
  it('returns nearest point on arc when within arc angle', () => {
    const result = nearestPointOnArc(20, 0, 0, 0, 10, 0, 90)
    expect(result.position[0]).toBeCloseTo(10, 1)
    expect(result.position[1]).toBeCloseTo(0, 1)
  })

  it('returns nearest endpoint when point is outside arc', () => {
    const result = nearestPointOnArc(0, 20, 0, 0, 10, 0, 90)
    expect(result.position[0]).toBeCloseTo(0, 1)
    expect(result.position[1]).toBeCloseTo(10, 1)
  })

  it('returns the start endpoint when the point is just outside the start', () => {
    // Point angle is below the 0..90 span, so the nearest endpoint is the start
    // at (10,0), not the end at (0,10). A swapped start/end would return (0,10).
    const result = nearestPointOnArc(11, -1, 0, 0, 10, 0, 90)
    expect(result.position[0]).toBeCloseTo(10, 1)
    expect(result.position[1]).toBeCloseTo(0, 1)
  })

  it('returns nearest endpoint when arc spans 0 degrees', () => {
    const result = nearestPointOnArc(-20, 0, 0, 0, 10, -30, 30)
    expect(result.position[0]).toBeCloseTo(8.66, 1)
    expect(result.position[1]).toBeCloseTo(5, 1)
  })
})

describe('nearestPointOnEntity', () => {
  it('handles line segment', () => {
    const line: LineSegment = { start: [0, 0], end: [10, 0] }
    const result = nearestPointOnEntity(5, 5, line)
    expect(result).not.toBeNull()
    expect(result!.position).toEqual([5, 0])
  })

  it('handles circle', () => {
    const circle: Circle = { center: [0, 0], radius: 10 }
    const result = nearestPointOnEntity(20, 0, circle)
    expect(result).not.toBeNull()
    expect(result!.position).toEqual([10, 0])
  })

  it('handles arc', () => {
    const arc: Arc = { center: [0, 0], radius: 10, angle_start: 0, angle_end: 90, start: [10, 0], end: [0, 10] }
    const result = nearestPointOnEntity(20, 0, arc)
    expect(result).not.toBeNull()
    expect(result!.position[0]).toBeCloseTo(10, 1)
  })

  it('handles point', () => {
    const pt: PointEntity = { x: 5, y: 5 }
    const result = nearestPointOnEntity(5, 5, pt)
    expect(result).not.toBeNull()
    expect(result!.position).toEqual([5, 5])
    expect(result!.distance).toBeCloseTo(0)
  })

  it('returns null for unknown entity type', () => {
    const result = nearestPointOnEntity(0, 0, { unknown: true } as unknown as LineSegment)
    expect(result).toBeNull()
  })
})
