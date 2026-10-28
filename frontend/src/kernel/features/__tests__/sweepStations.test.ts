// The station rules of a multisection sweep, driven with analytic spine
// samplers so no WASM is involved: where the spine pierces each section plane,
// which crossing wins, and how the sections are ordered.
import { describe, it, expect } from 'vitest'
import {
  findStation,
  orderSections,
  pointOnOrInLoop,
  type SectionInput,
  type SpineSampler,
  type Vec3,
} from '../sweepStations'
import { CENTROID_ARC_SAMPLES, loopCentroid, pointInLoop, type LoopEdge } from '../../profileLoops'
import type { PlaneLike } from '../shared/planes'

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

const deg = (d: number): number => (d * Math.PI) / 180

/** A CCW rounded rectangle in sketch coords, one radius per corner. */
function roundedRectLoop(
  w: number, h: number, r: { br: number; tr: number; tl: number; bl: number },
): LoopEdge[] {
  const hx = w / 2
  const hy = h / 2
  const line = (a: [number, number], b: [number, number]): LoopEdge => (
    { kind: 'line', start: a, end: b }
  )
  const arc = (c: [number, number], a0: number, a1: number, radius: number): LoopEdge => ({
    kind: 'arc', center: c, radius, angle_start_deg: a0, angle_end_deg: a1, ccw: true,
    start: [c[0] + radius * Math.cos(deg(a0)), c[1] + radius * Math.sin(deg(a0))],
    end: [c[0] + radius * Math.cos(deg(a1)), c[1] + radius * Math.sin(deg(a1))],
  })
  return [
    line([-hx + r.bl, -hy], [hx - r.br, -hy]),
    arc([hx - r.br, -hy + r.br], -90, 0, r.br),
    line([hx, -hy + r.br], [hx, hy - r.tr]),
    arc([hx - r.tr, hy - r.tr], 0, 90, r.tr),
    line([hx - r.tr, hy], [-hx + r.tl, hy]),
    arc([-hx + r.tl, hy - r.tl], 90, 180, r.tl),
    line([-hx, hy - r.tl], [-hx, -hy + r.bl]),
    arc([-hx + r.bl, -hy + r.bl], 180, 270, r.bl),
  ]
}

/** The same loop drawn the other way round: the edge list reversed, every edge
 *  swapped, and every arc's angles swapped with its winding flipped. */
function reverseLoop(loop: LoopEdge[]): LoopEdge[] {
  return [...loop].reverse().map((e) => {
    const out: LoopEdge = { ...e, start: e['end'], end: e['start'] }
    if (e['kind'] === 'arc') {
      out['ccw'] = !(e['ccw'] as boolean)
      out['angle_start_deg'] = e['angle_end_deg']
      out['angle_end_deg'] = e['angle_start_deg']
    }
    return out
  })
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
    const twoDeg = deg(2)
    const n: Vec3 = [Math.sin(twoDeg), Math.cos(twoDeg), 0]
    const plane: PlaneLike = {
      origin: [5, 0, 0],
      x_axis: [Math.cos(twoDeg), -Math.sin(twoDeg), 0],
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
    // The pick index follows the user's list, not the station order, so the
    // same section keeps its number in every message.
    expect(ordered.map((s) => s.pick)).toEqual([2, 3, 1])
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

describe('sweepStations curved sections', () => {
  it('finds the station of a clockwise rounded rectangle section', () => {
    // A clockwise loop stores its arcs with ccw false, and the corners are
    // deliberately unequal so the centroid sits off the centre. The U spine's
    // two ends both pierce the section, so the centroid decides which crossing
    // is the station: the sampler that read a reversed arc's angles backwards
    // shifted the centroid far enough to pick the other end.
    const loop = reverseLoop(roundedRectLoop(6, 3, { br: 1, tr: 1, tl: 0.1, bl: 0.1 }))
    const u = polyline([
      [[0.2, 0, 0], [0.2, 0, -5]],
      [[0.2, 0, -5], [-0.6, 0, -5]],
      [[-0.6, 0, -5], [-0.6, 0, 0]],
    ])
    const outcome = findStation(u, planeZ(0), loop)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.station.point[0]).toBeCloseTo(0.2, 9)
    // The centroid itself is orientation-independent.
    const ccw = loopCentroid(roundedRectLoop(6, 3, { br: 1, tr: 1, tl: 0.1, bl: 0.1 }))
    const cw = loopCentroid(loop)
    expect(cw[0]).toBeCloseTo(ccw[0], 9)
    expect(cw[1]).toBeCloseTo(ccw[1], 9)
  })

  it('finds the station of an ellipse_arc section whose arc crosses 0 degrees', () => {
    // The section is a sliver at +x: an ellipse_arc from 350 to 10 degrees (so
    // the start angle is greater than the end one) closed by its chord. The
    // old local sampler ignored the winding and read the 340-degree COMPLEMENT,
    // putting the centroid on the far side and refusing a station the path
    // really pierces.
    const loop = [
      {
        kind: 'ellipse_arc', center: [0, 0], a: 2, b: 1, theta: 0,
        angle_start_deg: 350, angle_end_deg: 10, ccw: true,
        start: [2 * Math.cos(deg(350)), Math.sin(deg(350))],
        end: [2 * Math.cos(deg(10)), Math.sin(deg(10))],
      },
      {
        kind: 'line',
        start: [2 * Math.cos(deg(10)), Math.sin(deg(10))],
        end: [2 * Math.cos(deg(350)), Math.sin(deg(350))],
      },
    ] as LoopEdge[]
    // The spine pierces the sliver at (1.98, 0), between the arc and the chord.
    const spine = polyline([[[1.98, 0, 0], [1.98, 0, 10]]])
    const outcome = findStation(spine, planeZ(5), loop)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.station.point[0]).toBeCloseTo(1.98, 9)
    expect(outcome.station.fraction).toBeCloseTo(0.5, 9)
  })
})

describe('sweepStations loop containment', () => {
  it('centroids a square at its centre', () => {
    expect(loopCentroid(squareLoop(3, -2, 2))[0]).toBeCloseTo(3, 9)
    expect(loopCentroid(squareLoop(3, -2, 2))[1]).toBeCloseTo(-2, 9)
  })

  it('tests inside, outside and on the boundary', () => {
    const loop = squareLoop(0, 0, 1)
    expect(pointOnOrInLoop(loop, [0, 0])).toBe(true)
    expect(pointOnOrInLoop(loop, [0.99, 0])).toBe(true)
    expect(pointOnOrInLoop(loop, [2, 0])).toBe(false)
    expect(pointOnOrInLoop(loop, [1, 0])).toBe(true)
  })

  it('samples an arc boundary as a curve, not as its chord', () => {
    // A half circle of radius 2 around the origin: the polygon must bulge past
    // the chord at y=0, so a point at (0, 1.9) is inside.
    const loop = [{
      kind: 'arc', center: [0, 0], radius: 2,
      angle_start_deg: 0, angle_end_deg: 180, ccw: true,
      start: [2, 0], end: [-2, 0],
    }] as LoopEdge[]
    expect(pointInLoop([0, 1.9], loop, CENTROID_ARC_SAMPLES)).toBe(true)
    expect(pointInLoop([0, 2.1], loop, CENTROID_ARC_SAMPLES)).toBe(false)
  })
})
