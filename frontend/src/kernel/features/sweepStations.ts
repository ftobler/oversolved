// Where the spine pierces each section's plane, and in what order the sections
// sit along it. Pure geometry, no OCC: `sweep.ts` hands in a sampler built from
// the resolved spine edges, so the station rules unit-test against analytic
// curves.
//
// A section's station is derived, never stored: the section is placed where the
// user drew it, and a stored parameter would be a second truth that drifts as
// soon as the path is edited. The rule is the plane/spine crossing nearest the
// loop's own centroid, which must then lie inside the loop.

import type { PlaneLike } from './shared/planes'
import type { LoopEdge } from '../profileLoops'
import { OCC_CONFUSION } from '../solverConstants'

export type Vec3 = [number, number, number]

/** Samples one spine edge at `t` in [0, 1] (0 = edge start, 1 = edge end). The
 *  edges are the chain the sweep will build, in chain order. */
export type SpineSampler = {
  edgeCount: number
  sample(edgeIdx: number, t: number): Vec3
}

/** One section: its own plane and its outer loop, in that plane's sketch coords. */
export type SectionInput = {
  sketchId: string
  plane: PlaneLike
  loop: LoopEdge[]
}

/** Where a section sits on the spine. `fraction` is an arc-length fraction over
 *  the whole spine, used for messages and station order only. */
export type Station = {
  point: Vec3
  edge: number
  t: number
  fraction: number
}

export type StationedSection = SectionInput & { station: Station }

export type StationOutcome =
  | { ok: true; station: Station }
  | { ok: false; reason: 'not-on-path' | 'shallow-angle' }

// A sample this close to the plane counts as on it, so a section sitting exactly
// at the spine's start or end is found (its signed distance is a rounding error,
// not a sign change).
const ON_PLANE = 1e-9
// Absolute angle floor: below 5 degrees the crossing is ill-conditioned however
// long the spine is, which is why this is a sine of an angle and not a length.
const MIN_CROSSING_SIN = Math.sin((5 * Math.PI) / 180)
const SAMPLES_PER_EDGE = 32
const BISECTION_STEPS = 60
// Parameter step used to measure |n . t| at a crossing.
const SLOPE_STEP = 1e-3
const LOOP_ARC_STEPS = 16

type Crossing = { edge: number; t: number; point: Vec3 }

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dist3(a: Vec3, b: Vec3): number {
  const d = sub3(a, b)
  return Math.hypot(d[0], d[1], d[2])
}

/** A unit plane normal plus its origin, so a non-unit frame cannot skew the
 *  signed distance or the shallow-angle bound. */
function planeFrame(plane: PlaneLike): { n: Vec3; o: Vec3 } {
  const n = plane.normal as Vec3
  const len = Math.hypot(n[0], n[1], n[2])
  if (len < 1e-12) throw new Error('sweep: section plane has no normal')
  return { n: [n[0] / len, n[1] / len, n[2] / len], o: plane.origin as Vec3 }
}

function signedDistance(frame: { n: Vec3; o: Vec3 }, p: Vec3): number {
  return (
    (p[0] - frame.o[0]) * frame.n[0] +
    (p[1] - frame.o[1]) * frame.n[1] +
    (p[2] - frame.o[2]) * frame.n[2]
  )
}

/** The loop as a closed 2D polygon. Arcs and ellipses are sampled, a spline is
 *  evaluated as the cubic Bezier it is, so the inside test follows the drawn
 *  boundary rather than its control polygon. */
export function loopPolygon2d(loop: LoopEdge[]): number[][] {
  const pts: number[][] = []
  const push = (p: unknown): void => {
    if (!Array.isArray(p) || p.length < 2) return
    const q = [p[0] as number, p[1] as number]
    const last = pts[pts.length - 1]
    if (last !== undefined && last[0] === q[0] && last[1] === q[1]) return
    pts.push(q)
  }
  for (const edge of loop) {
    const kind = edge['kind'] as string | undefined
    if ((kind === 'arc' || kind === 'ellipse' || kind === 'ellipse_arc') && Array.isArray(edge['center'])) {
      const c = edge['center'] as number[]
      const a = kind === 'arc' ? (edge['radius'] as number) : (edge['a'] as number)
      const b = kind === 'arc' ? (edge['radius'] as number) : (edge['b'] as number)
      const theta = (kind === 'arc' ? 0 : ((edge['theta'] as number) ?? 0)) * (Math.PI / 180)
      const ccw = (edge['ccw'] as boolean) ?? true
      let lo = kind === 'ellipse' ? 0 : ((edge['angle_start_deg'] as number) ?? 0)
      let hi = kind === 'ellipse' ? 360 : ((edge['angle_end_deg'] as number) ?? 360)
      if (!ccw) [lo, hi] = [hi, lo]
      const r0 = lo * (Math.PI / 180)
      const r1 = hi * (Math.PI / 180)
      for (let i = 0; i <= LOOP_ARC_STEPS; i++) {
        const t = r0 + ((r1 - r0) * i) / LOOP_ARC_STEPS
        push([
          c[0] + a * Math.cos(t) * Math.cos(theta) - b * Math.sin(t) * Math.sin(theta),
          c[1] + a * Math.cos(t) * Math.sin(theta) + b * Math.sin(t) * Math.cos(theta),
        ])
      }
      continue
    }
    if (kind === 'spline' && Array.isArray(edge['c1']) && Array.isArray(edge['c2'])) {
      const p0 = edge['start'] as number[]
      const p1 = edge['c1'] as number[]
      const p2 = edge['c2'] as number[]
      const p3 = edge['end'] as number[]
      for (let i = 0; i <= LOOP_ARC_STEPS; i++) {
        const t = i / LOOP_ARC_STEPS
        const u = 1 - t
        const w0 = u * u * u
        const w1 = 3 * u * u * t
        const w2 = 3 * u * t * t
        const w3 = t * t * t
        push([
          w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
          w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
        ])
      }
      continue
    }
    push(edge['start'])
    push(edge['end'])
  }
  return pts
}

/** Area-weighted centroid of a simple closed polygon (shoelace). Falls back to
 *  the vertex average for a degenerate polygon, where no area centroid exists. */
export function polygonCentroid2d(poly: number[][]): number[] {
  let area2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const cross = a[0] * b[1] - b[0] * a[1]
    area2 += cross
    cx += (a[0] + b[0]) * cross
    cy += (a[1] + b[1]) * cross
  }
  if (Math.abs(area2) < 1e-12) {
    let sx = 0
    let sy = 0
    for (const p of poly) {
      sx += p[0]
      sy += p[1]
    }
    return poly.length === 0 ? [0, 0] : [sx / poly.length, sy / poly.length]
  }
  return [cx / (3 * area2), cy / (3 * area2)]
}

/** Ray-casting inside test on a closed polygon. Points exactly on the boundary
 *  count as inside: a station on the loop is still a station. */
export function pointInPolygon2d(poly: number[][], p: number[]): boolean {
  if (poly.length < 3) return false
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    // On the edge (within a hair) counts as inside.
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const len2 = ex * ex + ey * ey
    if (len2 > 0) {
      const u = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2
      if (u >= 0 && u <= 1) {
        const dx = p[0] - (a[0] + u * ex)
        const dy = p[1] - (a[1] + u * ey)
        if (Math.hypot(dx, dy) <= 1e-9) return true
      }
    }
    if ((a[1] > p[1]) !== (b[1] > p[1])) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
      if (x > p[0]) inside = !inside
    }
  }
  return inside
}

function bisect(
  sampler: SpineSampler,
  edge: number,
  ta: number,
  da: number,
  tb: number,
  db: number,
  frame: { n: Vec3; o: Vec3 },
): Crossing {
  let a = ta
  let b = tb
  let va = da
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const m = (a + b) / 2
    const p = sampler.sample(edge, m)
    const vm = signedDistance(frame, p)
    if (Math.abs(vm) < 1e-13) return { edge, t: m, point: p }
    if (vm < 0 === va < 0) {
      a = m
      va = vm
    } else {
      b = m
    }
  }
  const t = (a + b) / 2
  return { edge, t, point: sampler.sample(edge, t) }
}

/** |n . t| at a crossing, measured from the sampled curve so a curved spine is
 *  handled exactly as a straight one. */
function crossingSlope(
  sampler: SpineSampler,
  crossing: Crossing,
  frame: { n: Vec3; o: Vec3 },
): number {
  const t0 = Math.max(0, crossing.t - SLOPE_STEP)
  const t1 = Math.min(1, crossing.t + SLOPE_STEP)
  const p0 = sampler.sample(crossing.edge, t0)
  const p1 = sampler.sample(crossing.edge, t1)
  const run = dist3(p0, p1)
  if (run < 1e-12) return 0
  return Math.abs(signedDistance(frame, p1) - signedDistance(frame, p0)) / run
}

/**
 * The station of one section: the plane/spine crossing nearest the loop's
 * centroid, which must lie inside the loop and must not be near-tangent.
 */
export function findStation(
  sampler: SpineSampler,
  plane: PlaneLike,
  loop: LoopEdge[],
): StationOutcome {
  const frame = planeFrame(plane)
  const crossings: Crossing[] = []
  const edgeLengths: number[] = []

  for (let e = 0; e < sampler.edgeCount; e++) {
    let prev = sampler.sample(e, 0)
    let dPrev = signedDistance(frame, prev)
    let length = 0
    if (e === 0 && Math.abs(dPrev) <= ON_PLANE) {
      crossings.push({ edge: 0, t: 0, point: prev })
    }
    for (let k = 1; k <= SAMPLES_PER_EDGE; k++) {
      const t = k / SAMPLES_PER_EDGE
      const cur = sampler.sample(e, t)
      const dCur = signedDistance(frame, cur)
      length += dist3(prev, cur)
      if (dPrev * dCur < 0) {
        crossings.push(bisect(sampler, e, (k - 1) / SAMPLES_PER_EDGE, dPrev, t, dCur, frame))
      } else if (Math.abs(dCur) <= ON_PLANE) {
        crossings.push({ edge: e, t, point: cur })
      }
      prev = cur
      dPrev = dCur
    }
    edgeLengths.push(length)
  }

  if (crossings.length === 0) return { ok: false, reason: 'not-on-path' }

  const poly = loopPolygon2d(loop)
  const centroid2d = polygonCentroid2d(poly)
  const centroid3d: Vec3 = [
    frame.o[0] + centroid2d[0] * plane.x_axis[0] + centroid2d[1] * plane.y_axis[0],
    frame.o[1] + centroid2d[0] * plane.x_axis[1] + centroid2d[1] * plane.y_axis[1],
    frame.o[2] + centroid2d[0] * plane.x_axis[2] + centroid2d[1] * plane.y_axis[2],
  ]
  let best = crossings[0]
  let bestDist = dist3(best.point, centroid3d)
  for (const c of crossings.slice(1)) {
    const d = dist3(c.point, centroid3d)
    if (d < bestDist) {
      best = c
      bestDist = d
    }
  }

  const local: number[] = [
    (best.point[0] - frame.o[0]) * plane.x_axis[0] +
      (best.point[1] - frame.o[1]) * plane.x_axis[1] +
      (best.point[2] - frame.o[2]) * plane.x_axis[2],
    (best.point[0] - frame.o[0]) * plane.y_axis[0] +
      (best.point[1] - frame.o[1]) * plane.y_axis[1] +
      (best.point[2] - frame.o[2]) * plane.y_axis[2],
  ]
  if (!pointInPolygon2d(poly, local)) return { ok: false, reason: 'not-on-path' }

  if (crossingSlope(sampler, best, frame) < MIN_CROSSING_SIN) {
    return { ok: false, reason: 'shallow-angle' }
  }

  const total = edgeLengths.reduce((a, b) => a + b, 0)
  const before = edgeLengths.slice(0, best.edge).reduce((a, b) => a + b, 0)
  const fraction = total > 0 ? (before + best.t * edgeLengths[best.edge]) / total : 0

  return {
    ok: true,
    station: { point: best.point, edge: best.edge, t: best.t, fraction },
  }
}

/**
 * Find every section's station, refuse the ones the path does not pierce, and
 * return the sections in station order. The list order the user picked means
 * nothing: the path decides where each section sits.
 */
export function orderSections(
  sections: SectionInput[],
  sampler: SpineSampler,
): StationedSection[] {
  const stationed: StationedSection[] = []
  for (let i = 0; i < sections.length; i++) {
    const outcome = findStation(sampler, sections[i].plane, sections[i].loop)
    if (!outcome.ok) {
      if (outcome.reason === 'shallow-angle') {
        throw new Error(
          `sweep: section ${i + 1} meets the path at a shallow angle; draw the section square to the path`,
        )
      }
      throw new Error(`sweep: section ${i + 1} is not on the path: the path does not pass through it`)
    }
    stationed.push({ ...sections[i], station: outcome.station })
  }
  // Every pair, not just neighbours: a hairpin can bring two far-apart stations
  // into the same place, which is exactly what confuses the section placement.
  for (let i = 0; i < stationed.length; i++) {
    for (let j = i + 1; j < stationed.length; j++) {
      if (dist3(stationed[i].station.point, stationed[j].station.point) < OCC_CONFUSION) {
        throw new Error(`sweep: sections ${i + 1} and ${j + 1} sit at the same station`)
      }
    }
  }
  return stationed.sort((a, b) => a.station.fraction - b.station.fraction)
}
