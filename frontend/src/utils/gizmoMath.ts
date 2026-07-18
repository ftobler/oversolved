// Ray math the assembly viewport's pointer surface runs on: where a pointer ray
// meets a drag plane, how far along a gizmo axis it slides, and how far it has
// swung around a rotation ring. Kept out of the viewport so the manipulation
// paths unit-test without a canvas (project doctrine: delete the Viewport and
// the logic still passes).
//
// A `Ray` direction need not be unit length; every formula here normalizes what
// it needs. Degenerate configurations (ray parallel to the plane, ray parallel
// to the axis, a zero-length swing vector) return null / 0 rather than NaN — a
// pointer gesture that cannot be interpreted must leave the part where it is.

import type { Vec3 } from '@/utils/transform3d'

export interface Ray {
  origin: Vec3
  direction: Vec3
}

const EPS = 1e-9

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s]
}

export function normalize(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2])
  if (n < EPS || !Number.isFinite(n)) return null
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** Null when the ray runs parallel to the plane (no single intersection). */
export function intersectRayPlane(ray: Ray, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const n = normalize(planeNormal)
  if (!n) return null
  const denom = dot(ray.direction, n)
  if (Math.abs(denom) < EPS) return null
  const t = dot(sub(planePoint, ray.origin), n) / denom
  return add(ray.origin, scale(ray.direction, t))
}

/**
 * Distance along `axisDir` from `axisPoint` to the axis point closest to the
 * ray. Null when the two lines are parallel. A translate handle drag is the
 * difference of two of these.
 */
export function closestParamOnAxis(ray: Ray, axisPoint: Vec3, axisDir: Vec3): number | null {
  const d1 = normalize(axisDir)
  const d2 = normalize(ray.direction)
  if (!d1 || !d2) return null
  const w = sub(axisPoint, ray.origin)
  const b = dot(d1, d2)
  const det = b * b - 1  // a = c = 1 for unit d1, d2
  if (Math.abs(det) < EPS) return null
  const e1 = -dot(w, d1)
  const e2 = -dot(w, d2)
  return (-e1 + b * e2) / det
}

/** Signed angle from `from` to `to` measured right-handed about `axis`. */
export function signedAngleAbout(axis: Vec3, from: Vec3, to: Vec3): number {
  const n = normalize(axis)
  if (!n) return 0
  // Only the components perpendicular to the axis carry a swing.
  const f = normalize(sub(from, scale(n, dot(from, n))))
  const t = normalize(sub(to, scale(n, dot(to, n))))
  if (!f || !t) return 0
  return Math.atan2(dot(n, cross(f, t)), dot(f, t))
}

const TWO_PI = Math.PI * 2

/**
 * `angle` continued from `previous` rather than wrapped into (-pi, pi].
 *
 * signedAngleAbout is an atan2 and so cannot tell a 190 degree swing from a
 * -170 degree one; a caller measuring a total against a fixed start therefore
 * reverses once the drag passes a half turn. Resolving each reading to the one
 * nearest the previous frame's total recovers the turn the user actually made,
 * which holds as long as the pointer is sampled more often than every half
 * turn, which is true of any real drag.
 */
export function unwrapAngle(angle: number, previous: number): number {
  let step = (angle - previous + Math.PI) % TWO_PI
  if (step < 0) step += TWO_PI  // JS % keeps the dividend's sign
  return previous + step - Math.PI
}
