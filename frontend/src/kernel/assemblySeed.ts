// Closed-form seeds for the mate solve. Levenberg-Marquardt started at identity
// lands in a local minimum when a face-to-face weld needs a half turn, so before
// the wire is encoded every part reachable from a grounded body through a mate
// that defines its pose is placed exactly, along a spanning tree. Pure and
// framework-free: no solver, no store. The document's authored seeds are never
// rewritten (the result only feeds `encodeMateInput`).
//
// The rule that keeps authored poses safe: a seed is replaced only when it does
// NOT already satisfy the mate that reaches it. A user drag or a baked solved
// pose is consistent, so it passes through bit-exact, which is also what stops a
// newly added part from dragging an already welded chain (the chain's seeds
// satisfy their mates and are kept).
//
// The formulas mirror mate_residuals.rs (axis `a_w - s * b_w`, point
// coincidence with the offset carried in A's frame, absolute roll between the
// canonical perps), so a placed pose has residual ~0 for the placing mate.

import { cross, dot, normalize, scale, sub } from '@/utils/gizmoMath'
import {
  quatFromAxisAngle, quatMultiply, quatNormalize, rotateVector,
  type Quat, type Vec3,
} from '@/utils/transform3d'
import type { MateWireRecord } from './solveAssembly'

const BPB = 7

// Wire kind codes (mate.rs MateKind::to_u8) this module can place from.
const KIND_FIXED = 0
const KIND_SPHERICAL = 1
const KIND_ROTATING = 4
const KIND_SLIDING_ROTATING = 5

const PLACING_KINDS: ReadonlySet<number> = new Set([KIND_FIXED, KIND_SPHERICAL, KIND_ROTATING, KIND_SLIDING_ROTATING])

const PLACE_RANK: Record<number, number> = {
  [KIND_FIXED]: 0, [KIND_ROTATING]: 1, [KIND_SLIDING_ROTATING]: 1, [KIND_SPHERICAL]: 2,
}

/** A mate already holding within this (model units / unit axis) keeps its seed. */
const SATISFIED_TOL = 1e-6

interface Pose { t: Vec3; q: Quat }

function readPose(p: Float64Array, body: number): Pose {
  const o = body * BPB
  return { t: [p[o], p[o + 1], p[o + 2]], q: [p[o + 3], p[o + 4], p[o + 5], p[o + 6]] }
}

function writePose(p: Float64Array, body: number, pose: Pose): void {
  const o = body * BPB
  p[o] = pose.t[0]; p[o + 1] = pose.t[1]; p[o + 2] = pose.t[2]
  p[o + 3] = pose.q[0]; p[o + 4] = pose.q[1]; p[o + 5] = pose.q[2]; p[o + 6] = pose.q[3]
}

const dir = (pose: Pose, v: Vec3): Vec3 => rotateVector(pose.q, v)
const point = (pose: Pose, v: Vec3): Vec3 => {
  const r = rotateVector(pose.q, v)
  return [r[0] + pose.t[0], r[1] + pose.t[1], r[2] + pose.t[2]]
}
const unit = (v: Vec3): Vec3 => normalize(v) ?? [0, 0, 1]
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** Rotation taking the orthonormal local frame (u1,u2,u3) onto (v1,v2,v3). */
function quatFromFrames(u: [Vec3, Vec3, Vec3], v: [Vec3, Vec3, Vec3]): Quat {
  // R = sum v_i u_i^T, row-major.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let k = 0; k < 3; k++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r * 3 + c] += v[k][r] * u[k][c]
    }
  }
  const tr = m[0] + m[4] + m[8]
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, s / 4]
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    q = [s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    q = [(m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s, (m[2] - m[6]) / s]
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4, (m[3] - m[1]) / s]
  }
  return quatNormalize(q)
}

/** The frame (axis, perp, axis x perp) of an orthonormal local axis/perp pair. */
function frame(axis: Vec3, perp: Vec3): [Vec3, Vec3, Vec3] {
  const a = unit(axis)
  return [a, perp, cross(a, perp)]
}

/** Smallest rotation taking direction `from` onto `to`; a half turn about a fixed perpendicular when opposite. */
function quatBetween(from: Vec3, to: Vec3): Quat {
  const a = unit(from)
  const b = unit(to)
  const d = dot(a, b)
  if (d > 1 - 1e-12) return [0, 0, 0, 1]
  if (d < -1 + 1e-12) {
    const e: Vec3 = Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2])
      ? [1, 0, 0] : Math.abs(a[1]) <= Math.abs(a[2]) ? [0, 1, 0] : [0, 0, 1]
    return quatFromAxisAngle(unit(cross(a, e)), Math.PI)
  }
  const c = cross(a, b)
  return quatNormalize([c[0], c[1], c[2], 1 + d])
}

function wrapPi(x: number): number {
  return Math.atan2(Math.sin(x), Math.cos(x))
}

function roll(a: Pose, b: Pose, m: MateWireRecord): number {
  const w = unit(dir(a, m.axisA))
  const xa = dir(a, m.perpA)
  const xb = dir(b, m.perpB)
  return Math.atan2(dot(cross(xa, xb), w), dot(xa, xb))
}

/** Whether the mate already holds for the pair of poses (the placing rows only). */
function satisfied(a: Pose, b: Pose, m: MateWireRecord): boolean {
  const pa = point(a, m.pointA)
  const pb = point(b, m.pointB)
  if (m.kindCode === KIND_SPHERICAL) return Math.hypot(...sub(pa, pb)) <= SATISFIED_TOL
  const s = m.flip ? -1 : 1
  const aw = unit(dir(a, m.axisA))
  const bw = unit(dir(b, m.axisB))
  const axisGap = sub(aw, scale(bw, s))
  if (Math.hypot(...axisGap) > SATISFIED_TOL) return false
  if (m.kindCode === KIND_FIXED) {
    const gap = sub(add3(pa, dir(a, m.offset)), pb)
    if (Math.hypot(...gap) > SATISFIED_TOL) return false
    return Math.abs(wrapPi(roll(a, b, m) - m.angle)) <= SATISFIED_TOL
  }
  if (m.kindCode === KIND_ROTATING) return Math.hypot(...sub(pa, pb)) <= SATISFIED_TOL
  if (m.kindCode === KIND_SLIDING_ROTATING) return Math.hypot(...cross(sub(pa, pb), aw)) <= SATISFIED_TOL
  return true
}

/** B's pose from A's, closed form. Null when this mate cannot place B. */
function placeB(a: Pose, b: Pose, m: MateWireRecord): Pose | null {
  const s = m.flip ? -1 : 1
  const aw = unit(dir(a, m.axisA))
  const pa = point(a, m.pointA)
  if (m.kindCode === KIND_SPHERICAL) {
    return { t: add3(b.t, sub(pa, point(b, m.pointB))), q: b.q }
  }
  if (m.kindCode === KIND_FIXED) {
    const xa = dir(a, m.perpA)
    const xb = rotateVector(quatFromAxisAngle(aw, m.angle), xa)
    const bAxis = scale(aw, s)
    const q = quatFromFrames(frame(m.axisB, m.perpB), [bAxis, xb, cross(bAxis, xb)])
    const target = add3(pa, dir(a, m.offset))
    return { t: sub(target, rotateVector(q, m.pointB)), q }
  }
  if (m.kindCode === KIND_ROTATING || m.kindCode === KIND_SLIDING_ROTATING) {
    const q = quatNormalize(quatMultiply(quatBetween(dir(b, m.axisB), scale(aw, s)), b.q))
    const moved: Pose = { t: b.t, q }
    const gap = sub(pa, point(moved, m.pointB))
    // Rotating pins the point; sliding-rotating leaves the slide along the axis free.
    const shift = m.kindCode === KIND_ROTATING ? gap : sub(gap, scale(aw, dot(gap, aw)))
    return { t: add3(b.t, shift), q }
  }
  return null
}

/** A's pose from B's: the same mate read with the roles swapped. */
function placeA(a: Pose, b: Pose, m: MateWireRecord): Pose | null {
  const s = m.flip ? -1 : 1
  const bw = unit(dir(b, m.axisB))
  const pb = point(b, m.pointB)
  if (m.kindCode === KIND_SPHERICAL) {
    return { t: add3(a.t, sub(pb, point(a, m.pointA))), q: a.q }
  }
  if (m.kindCode === KIND_FIXED) {
    const aAxis = scale(bw, s)
    const xa = rotateVector(quatFromAxisAngle(aAxis, -m.angle), dir(b, m.perpB))
    const q = quatFromFrames(frame(m.axisA, m.perpA), [aAxis, xa, cross(aAxis, xa)])
    const pointOffset = add3(m.pointA, m.offset)
    return { t: sub(pb, rotateVector(q, pointOffset)), q }
  }
  if (m.kindCode === KIND_ROTATING || m.kindCode === KIND_SLIDING_ROTATING) {
    const q = quatNormalize(quatMultiply(quatBetween(dir(a, m.axisA), scale(bw, s)), a.q))
    const moved: Pose = { t: a.t, q }
    const gap = sub(pb, point(moved, m.pointA))
    const shift = m.kindCode === KIND_ROTATING ? gap : sub(gap, scale(bw, dot(gap, bw)))
    return { t: add3(a.t, shift), q }
  }
  return null
}

/**
 * Seeds for the solve: a copy of `params` (7 f64 per body) in which every part
 * reachable from a grounded body through a placing mate sits where that mate
 * wants it, unless its authored seed already satisfies the mate.
 *
 * Breadth-first from the grounded bodies; each part is placed by the first mate
 * that reaches it, and the rest (cycles, under-defining kinds, copy_rotation,
 * weighted drag objectives) are left to the solver.
 */
export function seedAssembly(
  params: Float64Array,
  fixedMask: Uint8Array,
  mates: readonly MateWireRecord[],
): Float64Array {
  const out = Float64Array.from(params)
  const bodyCount = out.length / BPB
  const placed = new Array<boolean>(bodyCount).fill(false)
  const grounded = (i: number) => ((fixedMask[Math.floor(i / 8)] ?? 0) >> (i % 8) & 1) === 1
  for (let i = 0; i < bodyCount; i++) placed[i] = grounded(i)

  // Each round places the one unplaced body reachable through the most
  // constraining placing mate (fixed before rotating before spherical), ties by
  // mate order: a spherical listed before a fixed weld on the same pair must not
  // win and leave the half turn to the solver.
  for (;;) {
    let best: MateWireRecord | null = null
    for (const m of mates) {
      if (m.weight !== 1 || m.bodyA === m.bodyB || !PLACING_KINDS.has(m.kindCode)) continue
      // A negative index is the wire's dropped-body sentinel (an inline anchor on
      // a handle that names no loaded part); the solver drops that mate too.
      if (m.bodyA < 0 || m.bodyB < 0 || m.bodyA >= bodyCount || m.bodyB >= bodyCount) continue
      if (placed[m.bodyA] === placed[m.bodyB]) continue
      if (best === null || PLACE_RANK[m.kindCode] < PLACE_RANK[best.kindCode]) best = m
    }
    if (best === null) break
    const aPlaced = placed[best.bodyA]
    const a = readPose(out, best.bodyA)
    const b = readPose(out, best.bodyB)
    const target = aPlaced ? best.bodyB : best.bodyA
    if (!satisfied(a, b, best)) {
      const next = aPlaced ? placeB(a, b, best) : placeA(a, b, best)
      if (next) writePose(out, target, next)
    }
    // Reached either way: a consistent seed counts as placed, so the walk
    // continues through it.
    placed[target] = true
  }
  return out
}
