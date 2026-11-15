// The curve pattern's placement law, pure: spacing over open and closed paths,
// the past-end drop, the wrap coincidence, and the three orientation frames.
// The paths here are analytic polylines built by hand, so every expected number
// is arithmetic rather than a kernel measurement; the real kernel test
// (curvePatternReal.test.ts) then measures the copies it builds.

import { describe, it, expect } from 'vitest'
import { placeOnPath, pastEndWarning, type CurvePlacementInput, type Vec3 } from '../curvePatternPlacement'
import { pathPolyline, type PathPolyline } from '../shared/pathSampler'
import { rotateVector } from '@/utils/transform3d'

const TAU = Math.PI * 2

/** A polyline along a sampled analytic curve, the shape samplePath produces. */
function polyline(points: Vec3[], closed = false): PathPolyline {
  return pathPolyline(points, closed)
}

/** A straight line of `length` along +X, sampled in `n` chords. */
function line(length: number, n = 8): PathPolyline {
  const points: Vec3[] = []
  for (let i = 0; i <= n; i++) points.push([(length * i) / n, 0, 0])
  return polyline(points)
}

/** A circle of radius r in the XY plane, walked counter-clockwise from (r,0). */
function circle(r: number, n = 64): PathPolyline {
  const points: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const a = (TAU * i) / n
    points.push([r * Math.cos(a), r * Math.sin(a), 0])
  }
  return polyline(points, true)
}

/** A helix-like 3D polyline: a spin of `turns` with a steady rise. */
function helix(r: number, rise: number, turns: number, n = 96): PathPolyline {
  const points: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const a = (TAU * turns * i) / n
    points.push([r * Math.cos(a), r * Math.sin(a), (rise * i) / n])
  }
  return polyline(points)
}

function input(path: PathPolyline, overrides: Partial<CurvePlacementInput> = {}): CurvePlacementInput {
  return {
    path,
    count: overrides.count ?? 4,
    indices: overrides.indices ?? Array.from({ length: (overrides.count ?? 4) - 1 }, (_, i) => i + 1),
    spacing: 'equal',
    distance: 10,
    reverse: false,
    orientation: 'fixed',
    normal: null,
    ...overrides,
  }
}

const near = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('curve pattern spacing', () => {
  it('splits an open path so the last instance lands on its end', () => {
    const result = placeOnPath(input(line(120), { count: 4 }))
    expect(result.placements.map((p) => Number(p.station.toFixed(6)))).toEqual([40, 80, 120])
    expect(result.pathLength).toBeCloseTo(120, 9)
    expect(result.spacing).toBeCloseTo(40, 9)
    expect(result.closed).toBe(false)
  })

  it('splits a closed path by the count, so nothing lands on the start twice', () => {
    const loop = circle(10)
    const result = placeOnPath(input(loop, { count: 6 }))
    expect(result.placements).toHaveLength(5)
    for (const [i, placement] of result.placements.entries()) {
      near(placement.station, (loop.total * (i + 1)) / 6)
    }
    near(result.spacing, loop.total / 6)
    expect(result.closed).toBe(true)
  })

  it('reads a distance as the arc length between neighbours', () => {
    const result = placeOnPath(input(line(100), { spacing: 'distance', distance: 30, count: 4 }))
    expect(result.placements.map((p) => Number(p.station.toFixed(6)))).toEqual([30, 60, 90])
    expect(result.dropped).toEqual([])
    expect(result.spacing).toBe(30)
  })

  it('drops the instances a distance cannot fit and names the run', () => {
    const result = placeOnPath(input(line(45), { spacing: 'distance', distance: 10, count: 8 }))
    expect(result.placements.map((p) => p.index)).toEqual([1, 2, 3, 4])
    expect(result.dropped).toEqual([5, 6, 7])
    expect(pastEndWarning(result.dropped, result.pathLength)).toBe('instances 5..7 run past the path end (length 45 mm)')
  })

  it('names a non-contiguous drop without claiming a skipped instance', () => {
    // Instance 5 was skipped by the user, so the run is 6..8, not 5..8.
    const result = placeOnPath(input(line(45), {
      spacing: 'distance', distance: 10, count: 10, indices: [1, 2, 3, 4, 6, 7, 8],
    }))
    expect(result.dropped).toEqual([6, 7, 8])
    expect(pastEndWarning(result.dropped, 45)).toBe('instances 6..8 run past the path end (length 45 mm)')
  })

  it('wraps a distance around a closed path', () => {
    // A 60 mm loop with a 20 mm distance puts instance 3 back on the source.
    const result = placeOnPath(input(line(60), { spacing: 'distance', distance: 15, count: 4 }))
    expect(result.placements.map((p) => Number(p.station.toFixed(6)))).toEqual([15, 30, 45])
  })

  it('refuses a wrap that lands on another instance', () => {
    const loop = circle(10)
    expect(() => placeOnPath(input(loop, {
      spacing: 'distance', distance: loop.total / 3, count: 4,
    }))).toThrow(/instance 3 lands on instance 0/)
  })

  it('refuses a distance that is not positive', () => {
    expect(() => placeOnPath(input(line(50), { spacing: 'distance', distance: 0, count: 3 })))
      .toThrow(/distance must be greater than zero/)
  })

  it('measures from the far end when reversed', () => {
    const result = placeOnPath(input(line(120), { count: 3, reverse: true }))
    // The stations read the same numbers, from the other end; the copy at 120
    // is where the path START used to be.
    expect(result.placements.map((p) => Number(p.station.toFixed(6)))).toEqual([60, 120])
    const last = result.placements[1].transform
    expect(last.tx).toBeCloseTo(-120, 6)
  })
})

describe('curve pattern orientation', () => {
  it('is a pure translation when fixed, whatever the path turns', () => {
    const result = placeOnPath(input(helix(10, 20, 1), { count: 3, orientation: 'fixed' }))
    for (const placement of result.placements) {
      expect(placement.transform.qx).toBe(0)
      expect(placement.transform.qy).toBe(0)
      expect(placement.transform.qz).toBe(0)
      expect(placement.transform.qw).toBe(1)
    }
  })

  it('turns a planar path about its normal, as an in-plane rotation', () => {
    const r = 10
    const result = placeOnPath(input(circle(r), { count: 4, orientation: 'tangent' }))
    // The circle starts at (r, 0) walking counter-clockwise, so its tangent
    // there is +Y. The placement maps that tangent onto the station's tangent,
    // keeps the plane normal fixed, and carries the start point to the station.
    // The station's own angle is the polyline's inscribed arc length, so the
    // turn is a quarter turn to the sampling's precision, not bit-exactly.
    const t0: Vec3 = [0, 1, 0]
    for (const [i, placement] of result.placements.entries()) {
      const angle = (TAU * (i + 1)) / 4
      const q = [placement.transform.qx, placement.transform.qy, placement.transform.qz, placement.transform.qw] as [number, number, number, number]
      const turned = rotateVector(q, t0)
      near(turned[0], -Math.sin(angle), 1e-3)
      near(turned[1], Math.cos(angle), 1e-3)
      near(turned[2], 0)
      const z = rotateVector(q, [0, 0, 1])
      near(z[2], 1)
      // Q P0 + t is the station, and P0 is (r, 0, 0).
      const qp = rotateVector(q, [r, 0, 0])
      near(placement.transform.tx + qp[0], r * Math.cos(angle))
      near(placement.transform.ty + qp[1], r * Math.sin(angle))
      near(placement.transform.tz + qp[2], 0)
    }
  })

  it('keeps a helix frame continuous instead of flipping it', () => {
    const result = placeOnPath(input(helix(10, 20, 1), { count: 9, orientation: 'tangent' }))
    // Every copy's rotation stays close to its neighbour's: a Frenet frame
    // would flip the normal at the turn's change of curvature, which reads as a
    // half-turn jump between two neighbours.
    const quats = [...result.placements.map((p) => [p.transform.qx, p.transform.qy, p.transform.qz, p.transform.qw])]
    quats.unshift([0, 0, 0, 1])
    for (let i = 1; i < quats.length; i++) {
      const a = quats[i - 1]
      const b = quats[i]
      const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
      expect(dot).toBeGreaterThan(0.9)
    }
  })

  it('equals the tangent frame when the path lies in the normal_to plane', () => {
    const tangent = placeOnPath(input(circle(10), { count: 5, orientation: 'tangent' }))
    const normalTo = placeOnPath(input(circle(10), {
      count: 5, orientation: 'normal_to', normal: [0, 0, 1],
    }))
    for (let i = 0; i < tangent.placements.length; i++) {
      const a = tangent.placements[i].transform
      const b = normalTo.placements[i].transform
      near(a.tx, b.tx)
      near(a.ty, b.ty)
      near(a.tz, b.tz)
      const dot = Math.abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw)
      expect(dot).toBeGreaterThan(1 - 1e-9)
    }
  })

  it('turns only about the normal in normal_to, even on a rising path', () => {
    const normal: Vec3 = [0, 0, 1]
    const result = placeOnPath(input(helix(10, 20, 1), {
      count: 4, orientation: 'normal_to', normal,
    }))
    for (const placement of result.placements) {
      const q = [placement.transform.qx, placement.transform.qy, placement.transform.qz, placement.transform.qw] as [number, number, number, number]
      // The rotated z axis is still the normal: the copies only spin about it.
      const z = rotateVector(q, [0, 0, 1])
      near(z[0], 0)
      near(z[1], 0)
      near(z[2], 1)
    }
  })

  it('refuses a normal_to station where the path runs along the normal', () => {
    expect(() => placeOnPath(input(line(50), {
      count: 3, orientation: 'normal_to', normal: [1, 0, 0],
    }))).toThrow(/instance 0 sits where the path runs along the normal/)
  })
})
