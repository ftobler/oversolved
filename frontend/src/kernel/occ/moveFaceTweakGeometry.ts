/**
 * The OCC-free geometry of the direct move-face tweak: the 3-plane vertex
 * solve and the branch choice that picks the moved intersection curve nearest
 * the old edge. Keeping these here makes them unit-testable without a WASM
 * kernel, which is the project's "delete the Viewport" rule applied to the
 * tweak's arithmetic.
 */

import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'

/** A plane by a point on it and a unit normal. */
export interface Plane {
  point: Vec3
  normal: Vec3
}

/** The intersection point of three planes, or null when they do not meet in a
 *  single point (two parallel, or all three through one line). The tweak falls
 *  back to the curve-based vertex solve for those. */
export function intersectThreePlanes(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const bc = cross(b.normal, c.normal)
  const det = dot(a.normal, bc)
  if (Math.abs(det) < 1e-12) return null
  const ca = cross(c.normal, a.normal)
  const ab = cross(a.normal, b.normal)
  const numerator = add(
    add(scale(bc, dot(a.normal, a.point)), scale(ca, dot(b.normal, b.point))),
    scale(ab, dot(c.normal, c.point)),
  )
  return scale(numerator, 1 / det)
}

/** The index of `candidates` nearest `near`, or -1 when empty. */
export function nearestIndex(candidates: readonly Vec3[], near: Vec3): number {
  let best = -1
  let bestDistance = Infinity
  candidates.forEach((p, i) => {
    const d = dot(sub(p, near), sub(p, near))
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

/**
 * The intersection branch that continues the old edge: the branch nearest the
 * old midpoint, with a tangent tie-break when two branches pass equally close
 * (a tangent cylinder and its mirror are the real case). `tangents` may carry
 * null where the branch's tangent was not read.
 */
export function chooseBranch(
  midpoints: readonly Vec3[],
  tangents: readonly (Vec3 | null)[],
  oldMidpoint: Vec3,
  oldTangent: Vec3 | null,
  distanceSlack: number,
): number {
  if (midpoints.length === 0) return -1
  const distances = midpoints.map((m) => Math.hypot(m[0] - oldMidpoint[0], m[1] - oldMidpoint[1], m[2] - oldMidpoint[2]))
  const closest = Math.min(...distances)
  let best = -1
  let bestScore = Infinity
  distances.forEach((d, i) => {
    if (d > closest + distanceSlack) return
    const tangent = tangents[i] ?? null
    const alignment = tangent === null || oldTangent === null ? 0 : Math.abs(dot(tangent, oldTangent))
    // Distance dominates; the tangent only separates branches that are already
    // within the slack of each other.
    const score = d * 1e3 - alignment
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  })
  return best
}
