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

/**
 * Euler XYZ (radians) -> quaternion, EXTRINSIC: rotate about world X first,
 * then world Y, then world Z, so `q = qz * qy * qx`. Extrinsic is what makes a
 * single-axis edit read the way a user expects ("rotated 90 about Z" turns the
 * part about the world Z it can see), which is the dominant case for placing a
 * fixed frame; intrinsic would measure the later axes in the part's own
 * already-turned frame.
 */
export function quatFromEulerXyz(euler: Vec3): Quat {
  const [rx, ry, rz] = euler
  const qx = quatFromAxisAngle([1, 0, 0], rx)
  const qy = quatFromAxisAngle([0, 1, 0], ry)
  const qz = quatFromAxisAngle([0, 0, 1], rz)
  return quatNormalize(quatMultiply(qz, quatMultiply(qy, qx)))
}

/**
 * Inverse of [[quatFromEulerXyz]]. Extracted off the rotation matrix of the
 * normalized quaternion (`R = Rz*Ry*Rx`), with `atan2` rather than `asin` on
 * the pitch so a quaternion a hair past unit cannot produce NaN.
 *
 * At gimbal lock (pitch at +/-90 deg) the X and Z rotations act on the same
 * axis and only their sum/difference is recoverable; roll is reported as zero
 * and the whole turn is attributed to Z. The round trip still reproduces the
 * same orientation, which is the property callers depend on -- but the numbers
 * shown for such a pose are not the ones that were typed.
 */
export function quatToEulerXyz(q: Quat): Vec3 {
  const [x, y, z, w] = quatNormalize(q)
  const r00 = 1 - 2 * (y * y + z * z)
  const r10 = 2 * (x * y + z * w)
  const r20 = 2 * (x * z - y * w)
  const r21 = 2 * (y * z + x * w)
  const r22 = 1 - 2 * (x * x + y * y)
  const cosPitch = Math.hypot(r21, r22)
  if (cosPitch < 1e-9) {
    const r01 = 2 * (x * y - z * w)
    const r11 = 1 - 2 * (x * x + z * z)
    return [0, Math.atan2(-r20, cosPitch), Math.atan2(-r01, r11)]
  }
  return [Math.atan2(r21, r22), Math.atan2(-r20, cosPitch), Math.atan2(r10, r00)]
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

// Orientation is compared rotation-aware: q and -q are the same physical
// rotation (quaternion double cover), so component-wise equality would report
// a phantom "changed" for a pose that merely arrived back at its start through
// the negated quaternion -- a ring drag returning exactly to start composes a
// full turn into -q, which used to manufacture spurious undo entries and
// re-solves. |dot| >= 1 - eps^2 is the sameness test; translations stay
// component-wise. Both operands are unit quaternions by construction
// (makeTransform and the solver output both normalize), which the dot test
// silently assumes -- a non-unit pair reads as "changed" even when parallel.
export function transformsEqual(a: Transform3D, b: Transform3D, eps = 1e-9): boolean {
  const qa = transformQuat(a)
  const qb = transformQuat(b)
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]
  return (
    Math.abs(a.tx - b.tx) <= eps && Math.abs(a.ty - b.ty) <= eps && Math.abs(a.tz - b.tz) <= eps &&
    Math.abs(dot) >= 1 - eps * eps
  )
}

// How many f32 ulps a bake treats as "the same pose". The mate wire is f32 in
// both directions, so a solve returns a pose that differs from an f64 seed only
// by f32 rounding on a free DOF. Persisting that difference every commit makes
// the free DOF walk by roughly one ulp per commit; a relative epsilon of a few
// ulps is what lets the bake recognise the rounding it must not write.
const APPROX_F32_EPS = 1e-6

// Like transformsEqual but for the bake's "did the solver actually move this
// part" question: each component is compared relative to its own magnitude, so
// the tolerance tracks the f32 quantum at the value, and the quaternion compare
// is rotation-aware (q and -q are the same pose). transformsEqual stays the
// exact-identity test, where an absolute epsilon is what "unchanged" means.
export function transformApproxEqual(a: Transform3D, b: Transform3D, eps = APPROX_F32_EPS): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= eps * Math.max(1, Math.abs(x), Math.abs(y))
  if (!close(a.tx, b.tx) || !close(a.ty, b.ty) || !close(a.tz, b.tz)) return false
  const qa = transformQuat(a)
  const qb = transformQuat(b)
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]
  return Math.abs(dot) >= 1 - eps * eps
}
