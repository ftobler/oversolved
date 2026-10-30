// Pure geometry of `add_part_pattern`: which order the pattern's holes are
// visited in, and the seed pose that lands a new instance's anchor on one hole.
//
// Both are authoring aids. The document only ever stores the resulting
// part_instance seeds and mates, so nothing here is persisted or re-run; the
// order just has to be deterministic so a re-run names the same handles.

import type { Transform3D } from '@/types/cad'
import { canonicalPerp } from '@/utils/mateOrientation'
import { add, cross, dot, normalize, scale, sub } from '@/utils/gizmoMath'
import { makeTransform, quatNormalize, rotateVector, type Quat, type Vec3 } from '@/utils/transform3d'

/** A target hole as the pattern sees it: its world point, axis and the roll
 *  reference the mate solver measures against (a posed canonicalPerp). */
export interface PatternPose {
  point: Vec3
  axis: Vec3
  x_axis: Vec3
}

// Radial spread under which the points count as one circle, relative to the mean radius.
const CIRCLE_SPREAD = 0.05
// Angles closer than this are one angle, so a point on the wrap seam sorts by
// position instead of by float noise.
const ANGLE_EPS = 1e-9

function centroid(points: readonly Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>((acc, p) => add(acc, p), [0, 0, 0])
  return scale(sum, 1 / points.length)
}

function lexicographic(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The mean anchor axis, sign-aligned to the first so antiparallel holes of
 *  one ring do not cancel. Null when the axes do not agree on a direction. */
function ringAxis(poses: readonly PatternPose[]): Vec3 | null {
  const first = normalize(poses[0].axis)
  if (!first) return null
  let sum: Vec3 = [0, 0, 0]
  for (const pose of poses) {
    const axis = normalize(pose.axis)
    if (!axis) return null
    sum = add(sum, dot(axis, first) < 0 ? scale(axis, -1) : axis)
  }
  return normalize(sum)
}

function isCircular(poses: readonly PatternPose[], center: Vec3, axis: Vec3): boolean {
  if (poses.length < 3) return false
  const radii = poses.map((pose) => {
    const d = sub(pose.point, center)
    const radial = sub(d, scale(axis, dot(d, axis)))
    return Math.hypot(radial[0], radial[1], radial[2])
  })
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length
  if (mean < 1e-9) return false
  return Math.max(...radii.map(r => Math.abs(r - mean))) / mean < CIRCLE_SPREAD
}

/** The direction of greatest spread, by power iteration on the covariance. The
 *  sign is fixed (first non-zero component positive) so input order is moot. */
function principalDirection(points: readonly Vec3[], center: Vec3): Vec3 {
  const offsets = points.map(p => sub(p, center))
  const farthest = offsets.reduce((best, o) => (dot(o, o) > dot(best, best) ? o : best), offsets[0])
  let v: Vec3 = normalize(farthest) ?? [1, 0, 0]
  for (let i = 0; i < 50; i++) {
    let next: Vec3 = [0, 0, 0]
    for (const o of offsets) next = add(next, scale(o, dot(o, v)))
    const unit = normalize(next)
    if (!unit) break
    v = unit
  }
  const lead = v.find(c => Math.abs(c) > 1e-9) ?? 1
  return lead < 0 ? scale(v, -1) : v
}

/**
 * The visiting order of a pattern: by angle about the best-fit ring axis when
 * the points lie on one circle (three or more, equal radius about their
 * centroid), otherwise by projection on their principal direction. Ties fall
 * back to the coordinates, so the order never depends on the input order.
 */
export function orderPatternPoses<T extends PatternPose>(items: readonly T[]): T[] {
  if (items.length < 2) return [...items]
  const center = centroid(items.map(item => item.point))
  const axis = ringAxis(items)
  let keyed: Array<{ item: T; key: number }>
  if (axis && isCircular(items, center, axis)) {
    const u = canonicalPerp(axis)
    const v = cross(axis, u)
    keyed = items.map((item) => {
      const d = sub(item.point, center)
      let angle = Math.atan2(dot(d, v), dot(d, u))
      if (angle < -ANGLE_EPS) angle += 2 * Math.PI
      return { item, key: Math.abs(angle) <= ANGLE_EPS ? 0 : angle }
    })
  } else {
    const direction = principalDirection(items.map(item => item.point), center)
    keyed = items.map(item => ({ item, key: dot(sub(item.point, center), direction) }))
  }
  return keyed
    .sort((a, b) => (Math.abs(a.key - b.key) > ANGLE_EPS ? a.key - b.key : lexicographic(a.item.point, b.item.point)))
    .map(entry => entry.item)
}

function quatFromBasis(m: readonly [Vec3, Vec3, Vec3]): Quat {
  // m holds the rotation's columns; the standard branchy matrix to quaternion.
  const [c0, c1, c2] = m
  const r00 = c0[0], r10 = c0[1], r20 = c0[2]
  const r01 = c1[0], r11 = c1[1], r21 = c1[2]
  const r02 = c2[0], r12 = c2[1], r22 = c2[2]
  const trace = r00 + r11 + r22
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return quatNormalize([(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s])
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    return quatNormalize([0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s])
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    return quatNormalize([(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s])
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2
  return quatNormalize([(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s])
}

function frame(axis: Vec3, x: Vec3): [Vec3, Vec3, Vec3] {
  return [x, cross(axis, x), axis]
}

/**
 * The seed transform that lands a new instance's anchor on a target hole: the
 * anchor's axis maps onto the target's (onto its negation for `flip`) and its
 * canonical roll frame onto the target's, so the captured angle reads 0 and the
 * seed is already a pose the mate holds. `local` is the anchor in the new
 * part's own frame.
 */
export function seedTransformForPose(
  local: { point: Vec3; axis: Vec3 },
  target: PatternPose,
  flip: boolean,
): Transform3D {
  const localAxis = normalize(local.axis) ?? [0, 0, 1]
  const targetAxis = normalize(target.axis) ?? [0, 0, 1]
  const wantAxis: Vec3 = flip ? scale(targetAxis, -1) : targetAxis
  // x is already perpendicular to its axis, and a flipped axis keeps the same
  // perpendicular, so the pair stays a valid right-handed frame either way.
  const from = frame(localAxis, canonicalPerp(localAxis))
  const to = frame(wantAxis, normalize(target.x_axis) ?? canonicalPerp(wantAxis))
  // R = To * From^T, applied column by column: R f_k = t_k.
  const basis: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const columns = basis.map(e => [0, 1, 2].reduce<Vec3>((image, k) => add(image, scale(to[k], dot(from[k], e))), [0, 0, 0]))
  const q = quatFromBasis([columns[0], columns[1], columns[2]])
  const rotated = rotateVector(q, local.point)
  return makeTransform(sub(target.point, rotated), q)
}
