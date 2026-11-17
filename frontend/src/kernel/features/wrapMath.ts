// Pure wrap math: no OCC, no repo. The wrap leaf (features/wrap.ts) and its OCC
// builder (occ/wrapSolid.ts) drive this module, so every point the kernel puts
// on the target and every refusal the user reads come from one closed-form map.
//
// The datum is the target's own geometry, never a pick: the axis of a cylinder,
// cone or torus projected into the sketch plane, or a sphere's centre. A
// footprint point at in-plane coordinates (a, d) from the projected axis (a
// along it, d across it) lands at meridian arc length s = a - a0 from the
// reference parallel and at angle theta = d / r0 around the axis, so lengths
// along and around the target are kept exactly at the reference parallel. a0 is
// the footprint's bounding-box centre along the axis and r0 the parallel radius
// there. A sphere has no axis: its map is the azimuthal equidistant one about
// the facing point, which keeps every radial distance from the projected
// centre.
//
// Every surface is rebuilt in its own frame: Z the target's axis, X pointing
// AWAY from the facing generatrix. The facing point therefore sits at u = pi and
// the parameter seam at the back, and the |theta| < pi refusal is what keeps a
// footprint off the seam. On the cylinder, cone and torus the map from (a, d) to
// the surface (u, v) is affine, so a straight sketch line is a straight p-curve
// there and builds exactly; every other curve (and every curve on a sphere) is a
// C1 Hermite chain fitted through mapped samples to a stated tolerance.

import type { PlaneLike } from './shared/planes'
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'

export type { Vec3 }

/** The analytic face of revolution a wrap lands on, read off the target face. */
export type WrapSurface =
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number }
  // OCC's cone: radius `refRadius` at `origin`, growing by tan(semiAngle) per
  // unit along `axis` (a negative angle narrows along it).
  | { kind: 'cone'; origin: Vec3; axis: Vec3; refRadius: number; semiAngle: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'torus'; origin: Vec3; axis: Vec3; majorRadius: number; minorRadius: number }

export type WrapSurfaceKind = WrapSurface['kind']

/** A wrap that cannot be built as authored. The message is the user's
 *  sentence; the leaf reports it as the feature's error. */
export class WrapRefusal extends Error {}

/** The pinned sentence for an axis that projects to a point in the sketch. */
export const WRAP_AXIS_PERPENDICULAR =
  "wrap: the sketch plane is perpendicular to the target's axis, so the axis has no " +
  'direction in the sketch; use a plane that contains or is parallel to the axis ' +
  '(for example a plane through the axis)'

// The projected axis is a point when its in-plane length (the sine of the angle
// between axis and plane normal) falls under this.
export const AXIS_IN_PLANE_MIN = 1e-6

/** Which half of a torus tube the reference parallel sits on: the outer half
 *  (away from the ring axis) or the inner one. */
export type TubeSide = 'outer' | 'inner'

export interface WrapInput {
  surface: WrapSurface
  /** The material lies on the axis (or centre) side of the face: a bore, a
   *  spherical cavity, a torus groove. Decides the facing side of a cylinder,
   *  cone and sphere, and the sign of the height. */
  concave: boolean
  plane: PlaneLike
  /** Boundary samples of the whole footprint in sketch 2D coordinates: they set
   *  the reference parallel and are what the range refusals test. */
  footprint: number[][]
  tubeSide?: TubeSide
}

/** A right-handed surface frame. The surface's u = 0 direction is `x`. */
export interface SurfaceFrame {
  origin: Vec3
  x: Vec3
  y: Vec3
  z: Vec3
}

/** The gp primitive a surface offset by `offset` is (radius terms already
 *  offset; for the cone `origin` moves along the axis, see `offsetSurface`). */
export interface OffsetSurface {
  kind: WrapSurfaceKind
  frame: SurfaceFrame
  radius: number
  // Torus tube radius; cone semi-angle.
  minor?: number
  semiAngle?: number
}

/** The resolved map. `offset` is the signed geometric offset along the
 *  surface's own outward normal (away from the axis or centre). */
export interface WrapMap {
  kind: WrapSurfaceKind
  /** The parameter-space point of a sketch point, on every offset, when the
   *  map is affine (cylinder, cone, torus); null on the sphere. */
  uv: ((p: number[]) => [number, number]) | null
  point: (p: number[], offset: number) => Vec3
  surfaceAt: (offset: number) => OffsetSurface
  // The facing point's outward direction (where theta = 0 lands).
  facing: Vec3
  // The radius of the reference parallel (a sphere: its own radius).
  r0: number
  // Torus only: the reference parallel's tube angle (OCC's v), so the leaf can
  // test it against the face's own v range.
  tubeAngle?: number
}

/** Whether angle `phi` lies in [lo, hi] on some 2 pi lift (a periodic
 *  parameter range such as a torus face's v). */
export function angleInRange(phi: number, [lo, hi]: [number, number]): boolean {
  const eps = 1e-9
  for (let k = -2; k <= 2; k++) {
    const p = phi + 2 * Math.PI * k
    if (p >= lo - eps && p <= hi + eps) return true
  }
  return false
}

const EPS = 1e-12

function unit(v: number[]): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2])
  if (n < EPS) throw new WrapRefusal('wrap: degenerate direction')
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** World point of sketch coordinates. */
function lift(plane: PlaneLike, p: number[]): Vec3 {
  return add(add(plane.origin, scale(plane.x_axis, p[0])), scale(plane.y_axis, p[1]))
}

/** `point` dropped onto the sketch plane along its normal. */
function dropOnPlane(plane: PlaneLike, point: Vec3): Vec3 {
  const n = unit(plane.normal)
  return sub(point, scale(n, dot(sub(point, plane.origin), n)))
}

/** The in-plane frame of a projected axis: L along it, perp across it (L x n). */
export interface AxisDatum {
  origin: Vec3
  along: Vec3
  across: Vec3
}

/**
 * The target axis projected into the sketch plane. Throws the pinned refusal
 * when the axis is (within AXIS_IN_PLANE_MIN) perpendicular to the plane.
 */
export function projectedAxis(plane: PlaneLike, origin: Vec3, axis: Vec3): AxisDatum {
  const n = unit(plane.normal)
  const a = unit(axis)
  const inPlane = sub(a, scale(n, dot(a, n)))
  if (Math.hypot(inPlane[0], inPlane[1], inPlane[2]) < AXIS_IN_PLANE_MIN) {
    throw new WrapRefusal(WRAP_AXIS_PERPENDICULAR)
  }
  const along = unit(inPlane)
  return { origin: dropOnPlane(plane, origin), along, across: cross(along, n) }
}

/** (a, d): the sketch point's coordinates along and across the projected axis. */
export function axisCoords(plane: PlaneLike, datum: AxisDatum, p: number[]): [number, number] {
  const rel = sub(lift(plane, p), datum.origin)
  return [dot(rel, datum.along), dot(rel, datum.across)]
}

/** The frame with Z along `axis` and X pointing away from `facing`. */
function backFrame(origin: Vec3, axis: Vec3, facing: Vec3): SurfaceFrame {
  const z = unit(axis)
  const x = unit(scale(facing, -1))
  return { origin, x, y: cross(z, x), z }
}

/** A point of a frame at angle u, radius r, height z. */
function onFrame(f: SurfaceFrame, u: number, r: number, z: number): Vec3 {
  const radial = add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u)))
  return add(add(f.origin, scale(radial, r)), scale(f.z, z))
}

/** The axis-side facing direction: the radial direction toward the sketch
 *  viewer (+normal), or away from it when the sketch looks at the far wall. */
function axialFacing(plane: PlaneLike, axis: Vec3, farWall: boolean): Vec3 {
  const n = unit(plane.normal)
  const a = unit(axis)
  const radial = unit(sub(n, scale(a, dot(n, a))))
  return farWall ? scale(radial, -1) : radial
}

/** The sign that makes +d move along +across at the facing point. */
function aroundSign(axis: Vec3, facing: Vec3, across: Vec3): number {
  return dot(cross(unit(axis), facing), across) >= 0 ? 1 : -1
}

function axialRange(plane: PlaneLike, datum: AxisDatum, footprint: number[][]): { a0: number; aHalf: number; dMax: number } {
  if (footprint.length === 0) throw new WrapRefusal('wrap: the profile has no boundary')
  let lo = Infinity
  let hi = -Infinity
  let dMax = 0
  for (const p of footprint) {
    const [a, d] = axisCoords(plane, datum, p)
    lo = Math.min(lo, a)
    hi = Math.max(hi, a)
    dMax = Math.max(dMax, Math.abs(d))
  }
  return { a0: (lo + hi) / 2, aHalf: (hi - lo) / 2, dMax }
}

function refuseAround(dMax: number, r0: number): void {
  if (dMax / r0 >= Math.PI) {
    throw new WrapRefusal(
      `wrap: the footprint reaches ${fmt((dMax / r0) * (180 / Math.PI))} degrees around the axis ` +
        'from the facing side; it must stay under 180 degrees, so it cannot meet itself round the back',
    )
  }
}

const fmt = (x: number): string => String(Math.round(x * 1000) / 1000)

function cylinderMap(input: WrapInput, s: Extract<WrapSurface, { kind: 'cylinder' }>): WrapMap {
  const datum = projectedAxis(input.plane, s.origin, s.axis)
  const facing = axialFacing(input.plane, s.axis, input.concave)
  const frame = backFrame(s.origin, s.axis, facing)
  const sigma = aroundSign(s.axis, facing, datum.across)
  const { dMax } = axialRange(input.plane, datum, input.footprint)
  refuseAround(dMax, s.radius)
  // The axial sketch coordinate is measured from the projected axis origin,
  // which is the frame origin's projection, so it is the height directly.
  const uv = (p: number[]): [number, number] => {
    const [a, d] = axisCoords(input.plane, datum, p)
    return [Math.PI + (sigma * d) / s.radius, a]
  }
  return {
    kind: 'cylinder',
    uv,
    point: (p, offset) => {
      const [u, v] = uv(p)
      return onFrame(frame, u, s.radius + offset, v)
    },
    surfaceAt: (offset) => ({ kind: 'cylinder', frame, radius: s.radius + offset }),
    facing,
    r0: s.radius,
  }
}

function coneMap(input: WrapInput, s: Extract<WrapSurface, { kind: 'cone' }>): WrapMap {
  const datum = projectedAxis(input.plane, s.origin, s.axis)
  const facing = axialFacing(input.plane, s.axis, input.concave)
  const frame = backFrame(s.origin, s.axis, facing)
  const sigma = aroundSign(s.axis, facing, datum.across)
  const { a0, dMax } = axialRange(input.plane, datum, input.footprint)
  const sin = Math.sin(s.semiAngle)
  const cos = Math.cos(s.semiAngle)
  // The reference parallel sits at axial height a0; OCC's v is the slant
  // length from the reference radius, which IS the meridian arc length.
  const v0 = a0 / cos
  const r0 = s.refRadius + v0 * sin
  if (r0 <= EPS) {
    throw new WrapRefusal("wrap: the footprint's centre lies past the cone's apex; move it onto the cone")
  }
  refuseAround(dMax, r0)
  const uv = (p: number[]): [number, number] => {
    const [a, d] = axisCoords(input.plane, datum, p)
    return [Math.PI + (sigma * d) / r0, v0 + (a - a0)]
  }
  // The normal offset of a cone is a cone with the same angle whose frame
  // slides along the axis: P + g n = (O - g sin Z) + (R + g cos + v sin) r + v cos Z,
  // so the same (u, v) is the same ruling and the side walls run along normals.
  const surfaceAt = (offset: number): OffsetSurface => ({
    kind: 'cone',
    frame: { ...frame, origin: add(frame.origin, scale(frame.z, -offset * sin)) },
    radius: s.refRadius + offset * cos,
    semiAngle: s.semiAngle,
  })
  return {
    kind: 'cone',
    uv,
    point: (p, offset) => {
      const [u, v] = uv(p)
      const f = surfaceAt(offset)
      return onFrame(f.frame, u, f.radius + v * sin, v * cos)
    },
    surfaceAt,
    facing,
    r0,
  }
}

function torusMap(input: WrapInput, s: Extract<WrapSurface, { kind: 'torus' }>): WrapMap {
  const datum = projectedAxis(input.plane, s.origin, s.axis)
  const { a0, aHalf, dMax } = axialRange(input.plane, datum, input.footprint)
  const r = s.minorRadius
  if (Math.abs(a0) > r) {
    throw new WrapRefusal(
      `wrap: the footprint's centre is ${fmt(Math.abs(a0))} from the torus' mid-plane, ` +
        `beyond its tube radius ${fmt(r)}; move it onto the tube`,
    )
  }
  // Round the tube the footprint would meet itself on the far side of a full
  // torus, which the face test cannot see.
  if (aHalf >= Math.PI * r) {
    throw new WrapRefusal(
      `wrap: the footprint spans ${fmt(2 * aHalf)} along the tube, at least its circumference ` +
        `${fmt(2 * Math.PI * r)}; it would meet itself round the tube`,
    )
  }
  const outerPhi = Math.asin(a0 / r)
  const phi0 = input.tubeSide === 'inner' ? Math.PI - outerPhi : outerPhi
  // The side of the ring that faces the sketch is the one whose material normal
  // points at the viewer. On the outer half of a convex tube (a donut) that is
  // the near side; an inner-half fillet (a bore's entry edge) or a concave tube
  // (a groove inside a bore) turns its material normal toward the axis there,
  // so the visible wall is the far side, exactly the cylinder's bore rule.
  const farWall = Math.cos(phi0) * (input.concave ? -1 : 1) < 0
  const facing = axialFacing(input.plane, s.axis, farWall)
  const frame = backFrame(s.origin, s.axis, facing)
  const sigma = aroundSign(s.axis, facing, datum.across)
  const r0 = s.majorRadius + r * Math.cos(phi0)
  if (r0 <= EPS) throw new WrapRefusal('wrap: the reference parallel of the torus has no radius')
  refuseAround(dMax, r0)
  // +a climbs the axis on either half of the tube: on the inner half the tube
  // angle runs the other way along the axis.
  const kappa = Math.cos(phi0) < 0 ? -1 : 1
  const uv = (p: number[]): [number, number] => {
    const [a, d] = axisCoords(input.plane, datum, p)
    return [Math.PI + (sigma * d) / r0, phi0 + (kappa * (a - a0)) / r]
  }
  return {
    kind: 'torus',
    uv,
    point: (p, offset) => {
      const [u, phi] = uv(p)
      const tube = r + offset
      return onFrame(frame, u, s.majorRadius + tube * Math.cos(phi), tube * Math.sin(phi))
    },
    surfaceAt: (offset) => ({ kind: 'torus', frame, radius: s.majorRadius, minor: r + offset }),
    facing,
    r0,
    tubeAngle: phi0,
  }
}

function sphereMap(input: WrapInput, s: Extract<WrapSurface, { kind: 'sphere' }>): WrapMap {
  const n = unit(input.plane.normal)
  const facing = input.concave ? scale(n, -1) : n
  const centre = dropOnPlane(input.plane, s.center)
  // The frame's pole axis lies in the sketch plane, so the facing point is on
  // the equator and the parameter poles are a quarter turn away: that is why
  // the hemisphere refusal below is the sphere's range, not the antipode.
  const frame = backFrame(s.center, unit(input.plane.y_axis), facing)
  let rhoMax = 0
  for (const p of input.footprint) {
    const q = sub(lift(input.plane, p), centre)
    rhoMax = Math.max(rhoMax, Math.hypot(q[0], q[1], q[2]))
  }
  if (rhoMax >= (Math.PI * s.radius) / 2) {
    throw new WrapRefusal(
      `wrap: the footprint reaches ${fmt(rhoMax)} from the sphere's projected centre; ` +
        `on a sphere it must stay within a quarter great circle (${fmt((Math.PI * s.radius) / 2)})`,
    )
  }
  return {
    kind: 'sphere',
    uv: null,
    point: (p, offset) => {
      const q = sub(lift(input.plane, p), centre)
      const rho = Math.hypot(q[0], q[1], q[2])
      const rad = s.radius + offset
      if (rho < EPS) return add(s.center, scale(facing, rad))
      const e = scale(q, 1 / rho)
      const phi = rho / s.radius
      return add(s.center, scale(add(scale(facing, Math.cos(phi)), scale(e, Math.sin(phi))), rad))
    },
    surfaceAt: (offset) => ({ kind: 'sphere', frame, radius: s.radius + offset }),
    facing,
    r0: s.radius,
  }
}

/** Resolve the map for one wrap, refusing a footprint the target cannot hold. */
export function wrapMap(input: WrapInput): WrapMap {
  const s = input.surface
  if (s.kind === 'cylinder') return cylinderMap(input, s)
  if (s.kind === 'cone') return coneMap(input, s)
  if (s.kind === 'torus') return torusMap(input, s)
  return sphereMap(input, s)
}

/**
 * The signed geometric offset of the top surface: an add (or new) grows along
 * the material's outward normal, a cut goes into the material. On a concave face
 * that outward normal points at the axis, so the sign flips.
 */
export function geometricOffset(height: number, operation: string, concave: boolean): number {
  const intoMaterial = operation === 'cut'
  return height * (intoMaterial ? -1 : 1) * (concave ? -1 : 1)
}

/**
 * Refuse an offset that collapses the surface onto its axis or centre: the
 * height would reach through the axis, which no wrap can build.
 */
export function refuseCollapsedOffset(surface: WrapSurface, map: WrapMap, offset: number, footprint: number[][]): void {
  const fail = (what?: string): never => {
    throw new WrapRefusal(
      `wrap: a height of ${fmt(Math.abs(offset))} reaches through the target's ` +
        `${what ?? (surface.kind === 'sphere' ? 'centre' : surface.kind === 'torus' ? 'tube centre' : 'axis')}; use a smaller height`,
    )
  }
  // On a torus's inner half a GROWING tube moves toward the ring axis: the top
  // point sits at R + (r + g) cos(phi), which passes the axis once r + g > R on
  // a shaft groove cut deep or a bore-entry fillet raised high.
  if (surface.kind === 'torus' && map.uv !== null) {
    const tube = surface.minorRadius + offset
    for (const p of footprint) {
      if (surface.majorRadius + tube * Math.cos(map.uv(p)[1]) <= EPS) fail('ring axis')
    }
  }
  if (offset >= 0) return
  if (surface.kind === 'cylinder' && surface.radius + offset <= EPS) fail()
  if (surface.kind === 'sphere' && surface.radius + offset <= EPS) fail()
  if (surface.kind === 'torus' && surface.minorRadius + offset <= EPS) fail()
  if (surface.kind === 'cone' && map.uv !== null) {
    const f = map.surfaceAt(offset)
    const sin = Math.sin(surface.semiAngle)
    for (const p of footprint) {
      const v = map.uv(p)[1]
      if (f.radius + v * sin <= EPS) fail()
    }
  }
}

// ─── Hermite chains ───

/** A C1 cubic chain in the `makeBSplineChainEdge` layout: 3M + 1 poles, M + 1
 *  knots (the curve's own parameters, so the derivative scale is exact). */
export interface HermiteChain {
  poles: Vec3[]
  knots: number[]
  // The largest sampled distance between the chain and the mapped curve.
  deviation: number
}

/** Cubic Bezier point at s in [0, 1]. */
function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, s: number): Vec3 {
  const m = 1 - s
  const b0 = m * m * m
  const b1 = 3 * m * m * s
  const b2 = 3 * m * s * s
  const b3 = s * s * s
  return [
    b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
    b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
    b0 * p0[2] + b1 * p1[2] + b2 * p2[2] + b3 * p3[2],
  ]
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** df/dt by a second-order difference, one-sided at the ends so f is never
 *  read outside [t0, t1] (a trimmed spline need not extend past its range). */
function derivative(f: (t: number) => Vec3, t: number, t0: number, t1: number): Vec3 {
  const h = (t1 - t0) * 1e-5
  let a: Vec3
  let b: Vec3
  let c: Vec3
  if (t - 2 * h < t0) {
    a = f(t)
    b = f(t + h)
    c = f(t + 2 * h)
    return [0, 1, 2].map((k) => (-3 * a[k] + 4 * b[k] - c[k]) / (2 * h)) as Vec3
  }
  if (t + 2 * h > t1) {
    a = f(t)
    b = f(t - h)
    c = f(t - 2 * h)
    return [0, 1, 2].map((k) => (3 * a[k] - 4 * b[k] + c[k]) / (2 * h)) as Vec3
  }
  a = f(t + h)
  b = f(t - h)
  return [0, 1, 2].map((k) => (a[k] - b[k]) / (2 * h)) as Vec3
}

/** The chain's poles for M uniform segments, with exact end points. */
function chainFor(f: (t: number) => Vec3, t0: number, t1: number, m: number, start: Vec3, end: Vec3): HermiteChain {
  const knots: number[] = []
  for (let i = 0; i <= m; i++) knots.push(t0 + ((t1 - t0) * i) / m)
  knots[m] = t1
  const pts = knots.map((t, i) => (i === 0 ? start : i === m ? end : f(t)))
  const ders = knots.map((t) => derivative(f, t, t0, t1))
  const poles: Vec3[] = [pts[0]]
  for (let i = 0; i < m; i++) {
    const dt = (knots[i + 1] - knots[i]) / 3
    poles.push(add(pts[i], scale(ders[i], dt)))
    poles.push(sub(pts[i + 1], scale(ders[i + 1], dt)))
    poles.push(pts[i + 1])
  }
  let deviation = 0
  for (let i = 0; i < m; i++) {
    for (const s of [0.25, 0.5, 0.75]) {
      const t = knots[i] + (knots[i + 1] - knots[i]) * s
      const q = bezier(poles[3 * i], poles[3 * i + 1], poles[3 * i + 2], poles[3 * i + 3], s)
      deviation = Math.max(deviation, distance(q, f(t)))
    }
  }
  return { poles, knots, deviation }
}

/** The most segments one edge may take before the fit is refused. */
export const MAX_HERMITE_SEGMENTS = 256

/**
 * Fit a C1 cubic chain to the mapped curve f on [t0, t1], doubling the segment
 * count until the sampled deviation is under `tol`. `start` and `end` are the
 * exact joint points, so neighbouring edges meet bit for bit. `minSegments`
 * gives a long or strongly curved edge a head start.
 */
export function hermiteChain(
  f: (t: number) => Vec3,
  t0: number,
  t1: number,
  tol: number,
  start: Vec3,
  end: Vec3,
  minSegments = 2,
): HermiteChain {
  let best: HermiteChain | null = null
  for (let m = Math.max(1, minSegments); m <= MAX_HERMITE_SEGMENTS; m *= 2) {
    const chain = chainFor(f, t0, t1, m, start, end)
    best = chain
    if (chain.deviation <= tol) return chain
  }
  throw new WrapRefusal(
    `wrap: a profile edge could not be fitted on the target within ${tol} ` +
      `(${fmt((best as HermiteChain).deviation)} after ${MAX_HERMITE_SEGMENTS} segments); simplify the curve`,
  )
}

/** The fit tolerance for a footprint of `size` (its bounding-box diagonal). */
export function wrapFitTolerance(size: number): number {
  return Math.max(1e-7, size * 1e-6)
}
