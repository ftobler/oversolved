// Pure rigid-body transform math over Transform3D (7 params: translation +
// unit quaternion). Viewport-free and framework-free: the assembly's drag and
// triad-gizmo paths compose transforms here, the anchor solver worker consumes
// the same 7-param layout on the wire (solveAssembly.ts).
//
// Convention: a Transform3D maps a part-local point p to world as
// `world = rotate(q, p) + t`. Quaternion multiplication follows the usual
// Hamilton product, so `quatMultiply(a, b)` applies b first, then a.

import type { Transform3D } from '@/types/cad'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]  // qx, qy, qz, qw

export const IDENTITY_TRANSFORM: Transform3D = {
  tx: 0, ty: 0, tz: 0,
  qx: 0, qy: 0, qz: 0, qw: 1,
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  // A degenerate quaternion has no meaningful direction to preserve; identity
  // is the only fail-safe answer (drifting to NaN would poison the solve seed).
  if (n === 0 || !Number.isFinite(n)) return [0, 0, 0, 1]
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

// Right-hand rule about `axis` (need not be unit; a zero axis yields identity).
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = Math.hypot(axis[0], axis[1], axis[2])
  if (n === 0) return [0, 0, 0, 1]
  const half = angle / 2
  const s = Math.sin(half) / n
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]
}

/**
 * Inverse of [[quatFromAxisAngle]]: the rotation `q` encodes, as an axis through
 * the origin plus an angle in [0, 2pi). A rotation of zero has no distinguished
 * axis, so it reports `+Z` and callers must key off `angle` alone. The input is
 * normalized first: a solver's quaternion is only unit to within its residual
 * tolerance, and `acos` of a `w` a hair past 1 is NaN.
 */
export function quatToAxisAngle(q: Quat): { axis: Vec3; angle: number } {
  const [x, y, z, w] = quatNormalize(q)
  const s = Math.sqrt(Math.max(0, 1 - w * w))  // = sin(angle/2), never negative
  if (s < 1e-9) return { axis: [0, 0, 1], angle: 0 }
  return { axis: [x / s, y / s, z / s], angle: 2 * Math.acos(Math.min(1, Math.max(-1, w))) }
}

export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q
  // v' = v + 2 * cross(q_vec, cross(q_vec, v) + w * v)
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

export function transformQuat(t: Transform3D): Quat {
  return [t.qx, t.qy, t.qz, t.qw]
}

export function transformTranslation(t: Transform3D): Vec3 {
  return [t.tx, t.ty, t.tz]
}

export function makeTransform(translation: Vec3, q: Quat): Transform3D {
  const [qx, qy, qz, qw] = quatNormalize(q)
  return { tx: translation[0], ty: translation[1], tz: translation[2], qx, qy, qz, qw }
}

/** World-space translation of a placed part: a pure drag delta. */
export function translateTransform(t: Transform3D, delta: Vec3): Transform3D {
  return { ...t, tx: t.tx + delta[0], ty: t.ty + delta[1], tz: t.tz + delta[2] }
}

/**
 * Rotate a placed part by `angle` about the world-space `axis` through `pivot`.
 * The rotation is applied in world space, so it pre-multiplies the part's own
 * orientation; the translation orbits the pivot. Passing the part's own origin
 * as pivot gives an in-place spin, which is what the triad gizmo does.
 */
export function rotateTransformAboutPoint(
  t: Transform3D,
  axis: Vec3,
  angle: number,
  pivot: Vec3,
): Transform3D {
  const r = quatFromAxisAngle(axis, angle)
  const q = quatNormalize(quatMultiply(r, transformQuat(t)))
  const offset: Vec3 = [t.tx - pivot[0], t.ty - pivot[1], t.tz - pivot[2]]
  const rotated = rotateVector(r, offset)
  return makeTransform(
    [pivot[0] + rotated[0], pivot[1] + rotated[1], pivot[2] + rotated[2]],
    q,
  )
}

/** Inverse rigid transform: undoes `world = rotate(q, p) + t`. */
export function invertTransform(t: Transform3D): Transform3D {
  const qi: Quat = [-t.qx, -t.qy, -t.qz, t.qw]
  return makeTransform(rotateVector(qi, [-t.tx, -t.ty, -t.tz]), qi)
}

/** `a ∘ b`: apply b to a point first, then a. */
export function composeTransforms(a: Transform3D, b: Transform3D): Transform3D {
  const qa = transformQuat(a)
  const t = rotateVector(qa, transformTranslation(b))
  return makeTransform([t[0] + a.tx, t[1] + a.ty, t[2] + a.tz], quatMultiply(qa, transformQuat(b)))
}

/**
 * The transform that carries `base` onto `current` (`current ∘ base⁻¹`).
 * The assembly viewport applies it as a group offset over vertices already
 * baked at `base`, so a live drag moves the drawn part without re-meshing.
 */
export function relativeTransform(current: Transform3D, base: Transform3D): Transform3D {
  return composeTransforms(current, invertTransform(base))
}

export function transformsEqual(a: Transform3D, b: Transform3D, eps = 1e-9): boolean {
  return (
    Math.abs(a.tx - b.tx) <= eps && Math.abs(a.ty - b.ty) <= eps && Math.abs(a.tz - b.tz) <= eps &&
    Math.abs(a.qx - b.qx) <= eps && Math.abs(a.qy - b.qy) <= eps &&
    Math.abs(a.qz - b.qz) <= eps && Math.abs(a.qw - b.qw) <= eps
  )
}
