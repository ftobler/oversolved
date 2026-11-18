// The world-space primitive union every pick resolves to before a measurement
// rule sees it. The adapters (body, sketch, datum, anchor) do all the
// classification, so the rules only ever handle these analytic shapes and can
// stay pure, order-independent and testable without OCC, React or a viewport.
//
// Lengths are in the document unit. Directions (line dir, circle/cylinder axis,
// plane normal) are unit vectors; a direction that cannot be normalized is a
// null primitive at the adapter, never a NaN here.
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'

export type { Vec3 }

/** A point: a sketch point/vertex or a body vertex. */
export interface PointPrimitive {
  type: 'point'
  p: Vec3
}

/**
 * A segment, not an infinite line: the rules use the infinite line for
 * distances and the segment for its length. `bounded` is false for a primitive
 * whose extent is unknown (an assembly anchor carries a point and a direction,
 * no endpoints), which keeps the skew-pair minimum distance off a made-up
 * segment.
 */
export interface LinePrimitive {
  type: 'line'
  p0: Vec3
  p1: Vec3
  dir: Vec3
  bounded: boolean
}

/** An arc or a full circle. `sweep` is the arc angle in radians, 2 pi for a
 *  full circle. Both are optional because an assembly circle anchor carries a
 *  centre and an axis but no extent; pair rules use only those, and a single
 *  pick then states nothing rather than a made-up radius. */
export interface CirclePrimitive {
  type: 'circle'
  center: Vec3
  axis: Vec3
  radius?: number
  sweep?: number
}

/** An ellipse: pairs through its centre like a circle, singles read a and b. */
export interface EllipsePrimitive {
  type: 'ellipse'
  center: Vec3
  axis: Vec3
  a: number
  b: number
}

/**
 * A flat face (bounded) or a datum plane (not). The rules treat both as
 * infinite; `bounded` is carried so a later kernel rule can tell a face from a
 * datum without re-deriving it.
 */
export interface PlanePrimitive {
  type: 'plane'
  point: Vec3
  normal: Vec3
  bounded: boolean
}

/** A cylinder face's pair rules use only the axis; `radius` is absent on an
 *  assembly anchor, which carries no face extent, so a single pick states
 *  nothing. `length` is the face's own axial extent, read from its mesh. */
export interface CylinderPrimitive {
  type: 'cylinder'
  axisPoint: Vec3
  axis: Vec3
  radius?: number
  length?: number
}

/** A sphere face's centre; `radius` is absent on an assembly anchor, so a
 *  single pick there states nothing. */
export interface SpherePrimitive {
  type: 'sphere'
  center: Vec3
  radius?: number
}

/** A cone measures through its axis; `semiAngle` (radians) arrives with
 *  measure-kernel-pairs step 1, so singles read nothing until then. */
export interface ConePrimitive {
  type: 'cone'
  axisPoint: Vec3
  axis: Vec3
  semiAngle?: number
}

/** A torus measures through its axis; the radii arrive with
 *  measure-kernel-pairs step 1. */
export interface TorusPrimitive {
  type: 'torus'
  center: Vec3
  axis: Vec3
  majorRadius?: number
  minorRadius?: number
}

/**
 * A classifiable pick with no analytic rule: a spline or partial-ellipse edge, a
 * freeform face, a cone/torus read off a bundle that predates surface_frame.
 * The kernel follow-up answers these; until it lands they read nothing.
 */
export interface OpaquePrimitive {
  type: 'opaque'
  what: string
  ref: string
}

/** A whole-body pick: no analytic rule, a kernel cell like an opaque pick. */
export interface SolidPrimitive {
  type: 'solid'
  partId: string
}

export type Primitive =
  | PointPrimitive
  | LinePrimitive
  | CirclePrimitive
  | EllipsePrimitive
  | PlanePrimitive
  | CylinderPrimitive
  | SpherePrimitive
  | ConePrimitive
  | TorusPrimitive
  | OpaquePrimitive
  | SolidPrimitive

export type PrimitiveType = Primitive['type']

/** Unit vector, or null when the input has no direction (the adapters turn
 *  that into an unresolvable pick rather than a NaN readout). */
export function normalize(v: readonly number[]): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2])
  if (!Number.isFinite(n) || n < 1e-12) return null
  return [v[0] / n, v[1] / n, v[2] / n]
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

/** |w x d| for a unit d: the perpendicular distance from a point to a line. */
export function pointToAxisDistance(p: Vec3, axisPoint: Vec3, axis: Vec3): number {
  return Math.hypot(...cross(sub(p, axisPoint), axis))
}

/** Distance between two parallel infinite lines, given one unit direction. */
export function parallelLineDistance(pA: Vec3, pB: Vec3, dir: Vec3): number {
  return Math.hypot(...cross(sub(pB, pA), dir))
}

/**
 * Minimum distance between two segments, endpoints included (the closed form,
 * clamped at both ends). Used only for the skew-edge pair, which is the one cell
 * whose distance is a segment fact rather than an infinite-line one.
 */
export function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1)
  const d2 = sub(q2, p2)
  const r = sub(p1, p2)
  const a = dot(d1, d1)
  const e = dot(d2, d2)
  const f = dot(d2, r)
  const EPS = 1e-12
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  let s = 0
  let t = 0
  if (a <= EPS && e <= EPS) return distance(p1, p2)
  if (a <= EPS) {
    t = clamp01(f / e)
  } else {
    const c = dot(d1, r)
    if (e <= EPS) {
      s = clamp01(-c / a)
    } else {
      const b = dot(d1, d2)
      const denom = a * e - b * b
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  return distance(add(p1, scale(d1, s)), add(p2, scale(d2, t)))
}
