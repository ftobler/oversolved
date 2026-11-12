// Where the spine pierces each section's plane, and in what order the sections
// sit along it, plus the one-profile placement band (a profile carried beside
// the path or off its plane). Pure geometry, no OCC: `sweep.ts` hands in a
// sampler built from the resolved spine edges, so the station rules unit-test
// against analytic curves.
//
// A section's station is derived, never stored: the section is placed where the
// user drew it, and a stored parameter would be a second truth that drifts as
// soon as the path is edited. The rule is the plane/spine crossing nearest the
// loop's own centroid, which must then lie inside the loop.
//
// The loop polygon, its centroid and the containment test all come from
// profileLoops. A second local copy of the arc rule drifted from the blessed
// one (it swapped a reversed arc's angles and sampled them increasing, which
// doubles the arc's area, and it read an ellipse_arc that crosses 0 degrees as
// the complement), so there is exactly one sampler for every loop question.

import type { PlaneLike } from './shared/planes'
import { CENTROID_ARC_SAMPLES, loopCentroid, loopPts, pointInLoop, type LoopEdge } from '../profileLoops'
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
  /** The 1-based ordinal of this outer loop within `sketchId`. A sketch that
   *  draws several disjoint loops contributes one section per loop, so the
   *  sketch id plus this ordinal is what a message names; a flattened section
   *  number would read as a pick position the user never chose. */
  loopIndex: number
  plane: PlaneLike
  loop: LoopEdge[]
}

/** Where a section sits on the spine. `fraction` is an arc-length fraction over
 *  the whole spine, used for messages and station order only. `local` is the
 *  crossing in the section plane's own coords, so a profile's holes can be
 *  tested against the same station without rebuilding the frame. */
export type Station = {
  point: Vec3
  local: [number, number]
  edge: number
  t: number
  fraction: number
}

export type StationedSection = SectionInput & {
  station: Station
  /** The section's 1-based position in the flattened section list, kept only
   *  for the same-station pair check. It is not a user-visible pick index:
   *  messages name the sketch and the loop ordinal instead. */
  sectionIndex: number
}

export type StationMiss = {
  ok: false
  reason: 'not-on-path' | 'shallow-angle'
  /** The distance from the loop centroid to the crossing nearest it, absent
   *  when the spine never crosses the plane (so there is no crossing to
   *  measure). */
  distance?: number
}

export type StationOutcome = { ok: true; station: Station } | StationMiss

/** The one-profile form's crossing slope floor. It has no station-to-station
 *  interpolation, so its only ill-conditioned case is a start lying in the
 *  profile plane; the multisection 5 degree floor would refuse a legitimate
 *  coil, where a radial profile on a helix crosses at
 *  `sin(atan(pitch / (2 pi r)))` (0.0477 at r 10, pitch 3). The no-crossing
 *  branch uses the 5 degree floor on the path start instead, because there is
 *  no crossing to measure one at. */
export const MIN_CROSSING_SIN_ONCE = 1e-6

// A sample this close to the plane counts as on it, so a section sitting exactly
// at the spine's start or end is found (its signed distance is a rounding error,
// not a sign change). The kernel's own "same point" length, not a literal.
const ON_PLANE = OCC_CONFUSION
// Absolute angle floor: below 5 degrees the crossing is ill-conditioned however
// long the spine is, which is why this is a sine of an angle and not a length.
const MIN_CROSSING_SIN = Math.sin((5 * Math.PI) / 180)
const SAMPLES_PER_EDGE = 32
const BISECTION_STEPS = 60
// Parameter step used to measure |n . t| at a crossing.
const SLOPE_STEP = 1e-3

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
function planeFrame(plane: PlaneLike, sectionIndex: number): { n: Vec3; o: Vec3 } {
  const n = plane.normal as Vec3
  const len = Math.hypot(n[0], n[1], n[2])
  if (len < 1e-12) throw new Error(`sweep: section ${sectionIndex + 1} plane has no normal`)
  return { n: [n[0] / len, n[1] / len, n[2] / len], o: plane.origin as Vec3 }
}

function signedDistance(frame: { n: Vec3; o: Vec3 }, p: Vec3): number {
  return (
    (p[0] - frame.o[0]) * frame.n[0] +
    (p[1] - frame.o[1]) * frame.n[1] +
    (p[2] - frame.o[2]) * frame.n[2]
  )
}

/**
 * Inside test on a loop, with the boundary counted as inside: a station on the
 * loop is still a station. `pointInLoop` is the project's one ray-casting test
 * and cannot say that for a point exactly on an edge, so the boundary is
 * checked within the kernel confusion length before falling back to it.
 *
 * Containment and the centroid use the same CENTROID_ARC_SAMPLES polygon as the
 * rest of the kernel, so a curved section is read as the shape the user drew.
 */
export function pointOnOrInLoop(loop: LoopEdge[], p: number[]): boolean {
  if (pointInLoop(p, loop, CENTROID_ARC_SAMPLES)) return true
  const poly = loopPts(loop, CENTROID_ARC_SAMPLES)
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const len2 = ex * ex + ey * ey
    if (!(len2 > 0)) continue
    const u = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2
    if (u < 0 || u > 1) continue
    const dx = p[0] - (a[0] + u * ex)
    const dy = p[1] - (a[1] + u * ey)
    if (Math.hypot(dx, dy) <= OCC_CONFUSION) return true
  }
  return false
}

/**
 * How far a 2D point lies outside a loop's boundary, 0 when it is inside (or
 * on) the loop. The polygon is the same `CENTROID_ARC_SAMPLES` one the
 * containment test and `loopCentroid` read, so a curved profile's gap and its
 * inside answer cannot disagree.
 */
export function loopBoundaryGap(loop: LoopEdge[], p: number[]): number {
  if (pointInLoop(p, loop, CENTROID_ARC_SAMPLES)) return 0
  const poly = loopPts(loop, CENTROID_ARC_SAMPLES)
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    const len2 = ex * ex + ey * ey
    const u = len2 > 0
      ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2))
      : 0
    const d = Math.hypot(p[0] - (a[0] + u * ex), p[1] - (a[1] + u * ey))
    if (d < best) best = d
  }
  return Number.isFinite(best) ? best : 0
}

/** The loop's own size: the bounding-box diagonal of its sampled polygon. The
 *  one-profile band is measured against this rather than the document unit, so
 *  it scales with the profile. */
export function loopExtent(loop: LoopEdge[]): number {
  const poly = loopPts(loop, CENTROID_ARC_SAMPLES)
  if (poly.length === 0) return 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

/**
 * How far a path start sits from a profile: its distance to the profile plane
 * combined in quadrature with the in-plane distance from its projection to the
 * loop, so a start straight over the loop's interior is just its height.
 */
export function profileStartGap(plane: PlaneLike, loop: LoopEdge[], start: Vec3): number {
  const frame = planeFrame(plane, 0)
  const d = signedDistance(frame, start)
  const projected: Vec3 = [
    start[0] - d * frame.n[0],
    start[1] - d * frame.n[1],
    start[2] - d * frame.n[2],
  ]
  return Math.hypot(d, loopBoundaryGap(loop, worldToLocal(plane, frame.o, projected)))
}

function bisect(
  sampler: SpineSampler,
  edge: number,
  ta: number,
  da: number,
  tb: number,
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
    if ((vm < 0) === (va < 0)) {
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

/** |n . t| at the path START, for the one-profile form's no-crossing branch:
 *  there is no crossing to measure one at, so the start's own tangent must
 *  leave the plane. */
function startSlope(sampler: SpineSampler, frame: { n: Vec3; o: Vec3 }): number {
  const p0 = sampler.sample(0, 0)
  const p1 = sampler.sample(0, SLOPE_STEP)
  const run = dist3(p0, p1)
  if (run < 1e-12) return 0
  return Math.abs(signedDistance(frame, p1) - signedDistance(frame, p0)) / run
}

/** A world point in the plane's own 2D sketch coords, relative to `origin`. */
function worldToLocal(plane: PlaneLike, origin: Vec3, p: Vec3): [number, number] {
  const x = plane.x_axis
  const y = plane.y_axis
  return [
    (p[0] - origin[0]) * x[0] + (p[1] - origin[1]) * x[1] + (p[2] - origin[2]) * x[2],
    (p[0] - origin[0]) * y[0] + (p[1] - origin[1]) * y[1] + (p[2] - origin[2]) * y[2],
  ]
}

/** Every plane crossing of the spine, with each edge's arclength so a station
 *  can name its fraction. Shared by the station rule and the one-profile
 *  placement rule, so the two read the same samples. */
function scanCrossings(
  sampler: SpineSampler,
  plane: PlaneLike,
  sectionIndex: number,
): { frame: { n: Vec3; o: Vec3 }; crossings: Crossing[]; edgeLengths: number[] } {
  const frame = planeFrame(plane, sectionIndex)
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
        crossings.push(bisect(sampler, e, (k - 1) / SAMPLES_PER_EDGE, dPrev, t, frame))
      } else if (Math.abs(dCur) <= ON_PLANE) {
        crossings.push({ edge: e, t, point: cur })
      }
      prev = cur
      dPrev = dCur
    }
    edgeLengths.push(length)
  }
  return { frame, crossings, edgeLengths }
}

/** The crossing nearest the loop's own centroid, the station rule's pick. */
function nearestCrossing(
  crossings: Crossing[],
  loop: LoopEdge[],
  plane: PlaneLike,
  origin: Vec3,
): Crossing {
  const centroid2d = loopCentroid(loop)
  const centroid3d: Vec3 = [
    origin[0] + centroid2d[0] * plane.x_axis[0] + centroid2d[1] * plane.y_axis[0],
    origin[1] + centroid2d[0] * plane.x_axis[1] + centroid2d[1] * plane.y_axis[1],
    origin[2] + centroid2d[0] * plane.x_axis[2] + centroid2d[1] * plane.y_axis[2],
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
  return best
}

/**
 * The station of one section: the plane/spine crossing nearest the loop's
 * centroid, which must lie inside the loop and must not be near-tangent.
 * `sectionIndex` is the 0-based flattened position, only used to name the
 * section in a plane error. `minCrossingSin` is the slope floor; the
 * multisection form keeps its absolute 5 degree bound. The one-profile form has
 * its own rule in `profilePlacement`.
 */
export function findStation(
  sampler: SpineSampler,
  plane: PlaneLike,
  loop: LoopEdge[],
  sectionIndex = 0,
  minCrossingSin = MIN_CROSSING_SIN,
): StationOutcome {
  const { frame, crossings, edgeLengths } = scanCrossings(sampler, plane, sectionIndex)

  if (crossings.length === 0) return { ok: false, reason: 'not-on-path' }

  const best = nearestCrossing(crossings, loop, plane, frame.o)
  const centroid2d = loopCentroid(loop)
  const centroid3d: Vec3 = [
    frame.o[0] + centroid2d[0] * plane.x_axis[0] + centroid2d[1] * plane.y_axis[0],
    frame.o[1] + centroid2d[0] * plane.x_axis[1] + centroid2d[1] * plane.y_axis[1],
    frame.o[2] + centroid2d[0] * plane.x_axis[2] + centroid2d[1] * plane.y_axis[2],
  ]
  const bestDist = dist3(best.point, centroid3d)
  const local = worldToLocal(plane, frame.o, best.point)
  if (!pointOnOrInLoop(loop, local)) {
    return { ok: false, reason: 'not-on-path', distance: bestDist }
  }

  if (crossingSlope(sampler, best, frame) < minCrossingSin) {
    return { ok: false, reason: 'shallow-angle', distance: bestDist }
  }

  const total = edgeLengths.reduce((a, b) => a + b, 0)
  const before = edgeLengths.slice(0, best.edge).reduce((a, b) => a + b, 0)
  const fraction = total > 0 ? (before + best.t * edgeLengths[best.edge]) / total : 0

  return {
    ok: true,
    station: { point: best.point, local, edge: best.edge, t: best.t, fraction },
  }
}

/**
 * Why the one-profile form refused. Separate from `StationMiss` because the
 * one-profile form reports a gap to the loop instead of a station miss, and the
 * multisection text must not change.
 */
export type ProfileMiss = {
  ok: false
  reason: 'not-on-path' | 'shallow-angle'
  // The crossing nearest the loop is this far outside its boundary.
  crossingGap?: number
  // The path never crosses the plane; its start is this far from the loop.
  startGap?: number
}

export type ProfilePlacement = { ok: true } | ProfileMiss

/**
 * The one-profile placement rule. MakePipeShell carries the profile rigidly
 * from the spine start, so a profile beside the path, or off its plane, is a
 * deliberate placement (a thread) and builds as drawn. The band is the outer
 * loop's own size: a crossing, or the start when the path never crosses, must
 * lie within it. `_holes` is deliberately not read: MakePipeShell carries the
 * holes, so a pipe's centreline running through its bore is on the profile. A
 * shallow crossing keeps its own refusal.
 */
export function profilePlacement(
  sampler: SpineSampler,
  plane: PlaneLike,
  outer: LoopEdge[],
  _holes: LoopEdge[][],
): ProfilePlacement {
  const { frame, crossings } = scanCrossings(sampler, plane, 0)
  const extent = loopExtent(outer)

  if (crossings.length === 0) {
    // There is no crossing to measure a slope at, so the start's own tangent
    // must leave the plane; a path running along the plane would otherwise
    // pass the distance test and sweep an edge-on profile.
    const gap = profileStartGap(plane, outer, sampler.sample(0, 0))
    if (gap > extent) return { ok: false, reason: 'not-on-path', startGap: gap }
    if (startSlope(sampler, frame) < MIN_CROSSING_SIN) return { ok: false, reason: 'shallow-angle' }
    return { ok: true }
  }

  const best = nearestCrossing(crossings, outer, plane, frame.o)
  const local = worldToLocal(plane, frame.o, best.point)
  if (pointOnOrInLoop(outer, local)) {
    // A crossing in a hole is the pipe placement, not a miss: the profile is
    // hollow there and MakePipeShell carries the bore along. The hole list is
    // deliberately not tested here; only the slope still matters.
    if (crossingSlope(sampler, best, frame) < MIN_CROSSING_SIN_ONCE) {
      return { ok: false, reason: 'shallow-angle' }
    }
    return { ok: true }
  }

  // Beside the loop: still a legitimate placement, refused only when the
  // crossing is farther off than the profile's own size.
  const gap = loopBoundaryGap(outer, local)
  if (gap > extent) return { ok: false, reason: 'not-on-path', crossingGap: gap }
  if (crossingSlope(sampler, best, frame) < MIN_CROSSING_SIN_ONCE) {
    return { ok: false, reason: 'shallow-angle' }
  }
  return { ok: true }
}

/** How a section message names its subject: the sketch the user picked plus
 *  the outer loop's ordinal in that sketch, and how many outer loops the
 *  sketch draws (above one, the refusal explains why it became several
 *  sections). */
export type SectionRef = {
  sketchId: string
  loopIndex: number
  outerLoops: number
}

function sectionWhere(ref: SectionRef): string {
  return `sketch ${ref.sketchId}, loop ${ref.loopIndex}`
}

/**
 * The one multisection refusal text, shared by `orderSections` so the station
 * messages cannot drift. A sketch that draws several outer loops produced
 * several sections and the path missing one is usually that split, so it names
 * the loop and the non-union rule rather than a bare section number.
 */
export function describeSectionMiss(outcome: StationMiss, ref: SectionRef): string {
  const where = sectionWhere(ref)
  if (outcome.reason === 'shallow-angle') {
    return `sweep: ${where} meets the path at a shallow angle; draw the section square to the path`
  }
  if (ref.outerLoops > 1) {
    return (
      `sweep: sketch ${ref.sketchId} holds ${ref.outerLoops} outer loops; a multisection sweep takes each ` +
      `outer loop as its own section, and the path does not pass through loop ${ref.loopIndex}. ` +
      'Loops are not unioned in a multisection section: draw one closed outer loop per section, or split ' +
      'the sketch into one sketch per section'
    )
  }
  return `sweep: ${where} is not on the path: the path does not pass through it`
}

/** The one-profile form's refusal text, in the same words as its catalog note.
 *  Gaps print as bare numbers: the kernel has no unit context, and the number
 *  is in the document's length unit either way. */
export function describeProfileMiss(outcome: ProfileMiss, pathRefs: string[]): string {
  if (outcome.reason === 'shallow-angle') {
    return 'sweep: the profile meets the path at a shallow angle; draw the profile square to the path'
  }
  const path = pathRefs.map((ref) => `'${ref}'`).join(', ')
  const gap = (v: number): string => String(Number(v.toFixed(2)))
  if (outcome.startGap !== undefined) {
    return (
      'sweep: the profile is too far from the path: the path never crosses its plane and starts ' +
      `${gap(outcome.startGap)} from it (the band is the profile's own size) (path ${path})`
    )
  }
  // The only not-on-path miss left is a crossing beside the loop, past the band.
  return (
    `sweep: the profile is too far from the path: the nearest crossing is ${gap(outcome.crossingGap ?? 0)} ` +
    `outside it (the band is the profile's own size) (path ${path})`
  )
}

/**
 * Find every section's station, refuse the ones the path does not pierce, and
 * return the sections in station order. The list order the user picked means
 * nothing: the path decides where each section sits.
 *
 * Messages name a section by its sketch id and loop ordinal, not by a pick
 * position: each outer loop of a sketch is its own section, so a flattened
 * index would point at a loop the user never picked separately.
 */
export function orderSections(
  sections: SectionInput[],
  sampler: SpineSampler,
): StationedSection[] {
  const outerLoopsBySketch = new Map<string, number>()
  for (const section of sections) {
    outerLoopsBySketch.set(section.sketchId, (outerLoopsBySketch.get(section.sketchId) ?? 0) + 1)
  }
  const refOf = (section: SectionInput): SectionRef => ({
    sketchId: section.sketchId,
    loopIndex: section.loopIndex,
    outerLoops: outerLoopsBySketch.get(section.sketchId) ?? 1,
  })

  const stationed: StationedSection[] = []
  for (let i = 0; i < sections.length; i++) {
    const outcome = findStation(sampler, sections[i].plane, sections[i].loop, i)
    if (!outcome.ok) throw new Error(describeSectionMiss(outcome, refOf(sections[i])))
    stationed.push({ ...sections[i], station: outcome.station, sectionIndex: i + 1 })
  }
  // Every pair, not just neighbours: a hairpin can bring two far-apart stations
  // into the same place, which is exactly what confuses the section placement.
  for (let i = 0; i < stationed.length; i++) {
    for (let j = i + 1; j < stationed.length; j++) {
      if (dist3(stationed[i].station.point, stationed[j].station.point) < OCC_CONFUSION) {
        throw new Error(
          `sweep: ${sectionWhere(refOf(stationed[i]))} and ${sectionWhere(refOf(stationed[j]))} ` +
          'sit at the same station',
        )
      }
    }
  }
  return stationed.sort((a, b) => a.station.fraction - b.station.fraction)
}
