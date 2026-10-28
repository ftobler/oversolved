// The station rules of a multisection sweep, driven with analytic spine
// samplers so no WASM is involved: where the spine pierces each section plane,
// which crossing wins, and how the sections are ordered.
import { describe, it, expect } from 'vitest'
import {
  findStation,
  orderSections,
  loopPolygon2d,
  pointInPolygon2d,
  polygonCentroid2d,
  type SectionInput,
  type SpineSampler,
  type Vec3,
} from '../sweepStations'
import type { PlaneLike } from '../shared/planes'
import type { LoopEdge } from '../../profileLoops'

function polyline(segments: [Vec3, Vec3][]): SpineSampler {
  return {
    edgeCount: segments.length,
    sample(edge, t) {
      const [a, b] = segments[edge]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    },
  }
}

/** A plane whose normal is world z, at height z. */
function planeZ(z: number): PlaneLike {
  return { origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

function squareLoop(cx: number, cy: number, half: number): LoopEdge[] {
  const c: [number, number][] = [
    [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half],
  ]
  const loop: LoopEdge[] = []
  for (let i = 0; i < 4; i++) {
    loop.push({ kind: 'line', start: c[i], end: c[(i + 1) % 4] } as LoopEdge)
  }
  return loop
}

function section(sketchId: string, plane: PlaneLike, loop: LoopEdge[]): SectionInput {
  return { sketchId, plane, loop }
}

const STRAIGHT = polyline([[[0, 0, 0], [0, 0, 10]]])

describe('sweepStations findStation', () => {
  it('finds the plane crossing of a straight spine', () => {
    const outcome = findStation(STRAIGHT, planeZ(5), squareLoop(0, 0, 1))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.station.point[2]).toBeCloseTo(5, 9)
    expect(outcome.station.fraction).toBeCloseTo(0.5, 9)
  })

  it('finds a section that sits exactly on the spine start and end', () => {
    const start = findStation(STRAIGHT, planeZ(0), squareLoop(0, 0, 1))
    const end = findStation(STRAIGHT, planeZ(10), squareLoop(0, 0, 1))
    expect(start.ok && start.station.fraction).toBeCloseTo(0, 9)
    expect(end.ok && end.station.fraction).toBeCloseTo(1, 9)
  })

  it('refuses a plane the spine crosses outside the loop', () => {
    const outcome = findStation(STRAIGHT, planeZ(5), squareLoop(100, 100, 1))
    expect(outcome).toEqual({ ok: false, reason: 'not-on-path' })
  })

  it('refuses a plane the spine never meets', () => {
    const short = polyline([[[0, 0, 0], [0, 0, 4]]])
    const outcome = findStation(short, planeZ(5), squareLoop(0, 0, 1))
    expect(outcome).toEqual({ ok: false, reason: 'not-on-path' })
  })

  it('refuses a near-tangent crossing at an absolute 5 degree floor', () => {
    const deg = (2 * Math.PI) / 180
    const n: Vec3 = [Math.sin(deg), Math.cos(deg), 0]
    const plane: PlaneLike = {
      origin: [5, 0, 0],
      x_axis: [Math.cos(deg), -Math.sin(deg), 0],
      y_axis: [0, 0, 1],
      normal: n,
    }
    const spine = polyline([[[0, 0, 0], [10, 0, 0]]])
    expect(findStation(spine, plane, squareLoop(0, 0, 1))).toEqual({ ok: false, reason: 'shallow-angle' })
    // The same spine square to the plane is accepted.
    const square: PlaneLike = { origin: [5, 0, 0], x_axis: [0, 1, 0], y_axis: [0, 0, 1], normal: [1, 0, 0] }
    expect(findStation(spine, square, squareLoop(0, 0, 1)).ok).toBe(true)
  })
})

describe('sweepStations orderSections', () => {
  it('orders three stations whatever the input order', () => {
    const sections = [
      section('c', planeZ(10), squareLoop(0, 0, 1)),
      section('a', planeZ(0), squareLoop(0, 0, 1)),
      section('b', planeZ(5), squareLoop(0, 0, 1)),
    ]
    const ordered = orderSections(sections, STRAIGHT)
    expect(ordered.map((s) => s.sketchId)).toEqual(['a', 'b', 'c'])
    expect(ordered.map((s) => Number(s.station.fraction.toFixed(9)))).toEqual([0, 0.5, 1])
  })

  it('gives each end of a U spine the crossing nearest its own loop', () => {
    // A squared U in the x/z plane: down, across, up. Both ends sit on z = 0.
    const u = polyline([
      [[0, 0, 0], [0, 0, -5]],
      [[0, 0, -5], [10, 0, -5]],
      [[10, 0, -5], [10, 0, 0]],
    ])
    const sections = [
      section('right', planeZ(0), squareLoop(10, 0, 1)),
      section('left', planeZ(0), squareLoop(0, 0, 1)),
    ]
    const ordered = orderSections(sections, u)
    expect(ordered.map((s) => s.sketchId)).toEqual(['left', 'right'])
    expect(ordered[0].station.point).toEqual([0, 0, 0])
    expect(ordered[1].station.point).toEqual([10, 0, 0])
    expect(ordered[0].station.fraction).toBeCloseTo(0, 9)
    expect(ordered[1].station.fraction).toBeCloseTo(1, 9)
  })

  it('names the section that is off the path', () => {
    const sections = [
      section('a', planeZ(5), squareLoop(0, 0, 1)),
      section('b', planeZ(7), squareLoop(100, 0, 1)),
    ]
    expect(() => orderSections(sections, STRAIGHT))
      .toThrow(/sweep: section 2 is not on the path: the path does not pass through it/)
  })

  it('names two sections that share a station', () => {
    const sections = [
      section('a', planeZ(5), squareLoop(0, 0, 1)),
      section('b', planeZ(5), squareLoop(0, 0, 2)),
    ]
    expect(() => orderSections(sections, STRAIGHT))
      .toThrow(/sweep: sections 1 and 2 sit at the same station/)
  })
})

describe('sweepStations loop geometry', () => {
  it('centroids a square at its centre', () => {
    const poly = loopPolygon2d(squareLoop(3, -2, 2))
    expect(polygonCentroid2d(poly)[0]).toBeCloseTo(3, 9)
    expect(polygonCentroid2d(poly)[1]).toBeCloseTo(-2, 9)
  })

  it('tests inside, outside and on the boundary', () => {
    const poly = loopPolygon2d(squareLoop(0, 0, 1))
    expect(pointInPolygon2d(poly, [0, 0])).toBe(true)
    expect(pointInPolygon2d(poly, [0.99, 0])).toBe(true)
    expect(pointInPolygon2d(poly, [2, 0])).toBe(false)
    expect(pointInPolygon2d(poly, [1, 0])).toBe(true)
  })

  it('samples an arc boundary as a curve, not as its chord', () => {
    // A half circle of radius 2 around the origin: the polygon must bulge past
    // the chord at y=0, so a point at (0, 1.9) is inside.
    const loop = [{
      kind: 'arc', center: [0, 0], radius: 2,
      angle_start_deg: 0, angle_end_deg: 180, ccw: true,
      start: [2, 0], end: [-2, 0],
    }] as LoopEdge[]
    expect(pointInPolygon2d(loopPolygon2d(loop), [0, 1.9])).toBe(true)
    expect(pointInPolygon2d(loopPolygon2d(loop), [0, 2.1])).toBe(false)
  })
})
