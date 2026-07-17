// The canonical anchor frame and roll measurement the mate solver's absolute
// orientation residuals are defined against (mate_residuals.rs: canonical_perp,
// abs_roll_residual). The solver measures roll between per-anchor reference
// directions; the editor captures the on-screen roll into the mate's `angle`
// when its references are picked. Both sides MUST measure with the same frame
// and the same formula, or the captured angle stops meaning "hold what I see":
// canonicalPerp here mirrors the Rust canonical_perp branch for branch, and the
// shared fixtures in mateOrientation.test.ts / canonical_perp_is_unit_and_
// perpendicular lock the two together.

import { cross, dot, normalize } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

/**
 * Deterministic unit vector perpendicular to `axis`: cross with the world basis
 * vector the axis is least aligned with. Pose-free -- feed it the anchor's
 * LOCAL axis, then carry the result through the part's rotation; computing it
 * from a world axis instead would pick a different branch as the part turns.
 */
export function canonicalPerp(axis: Vec3): Vec3 {
  const u = normalize(axis) ?? [0, 0, 1]
  const ax = Math.abs(u[0])
  const ay = Math.abs(u[1])
  const az = Math.abs(u[2])
  const e: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  return normalize(cross(u, e)) ?? [0, 0, 1]
}

/**
 * Signed roll (degrees, in (-180, 180]) from `xa` to `xb` measured right-handed
 * about `axisA`, exactly as the solver's roll residual reads it: the atan2 of
 * the cross projected on the axis over the plain dot. Deliberately does NOT
 * pre-project the vectors onto the axis plane (unlike gizmoMath's
 * signedAngleAbout) -- the capture must reproduce the solver's number even at a
 * pose whose axes are not yet aligned, or the mate solves away from the pose it
 * was authored at.
 */
export function rollAboutAxisDeg(xa: Vec3, xb: Vec3, axisA: Vec3): number {
  const w = normalize(axisA) ?? [0, 0, 1]
  const sin = dot(cross(xa, xb), w)
  const cos = dot(xa, xb)
  return Math.atan2(sin, cos) * (180 / Math.PI)
}
