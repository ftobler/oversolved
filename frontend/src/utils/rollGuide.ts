// The roll-guide arrow for a selected `fixed` mate (Stage 3 of mate-roll-angle):
// an arc from the mate's seed-relative zero roll out to the currently authored
// `angle`, traced about the mate's shared axis at ref_a's anchor point.
//
// Pure: no three.js, no store. `deriveAnchorFrame` (utils/anchorGizmos.ts)
// already derives a stable "zero roll" reference direction for an axis -- the
// same one every anchor triad draws its secondary arms from -- so the guide
// reuses it rather than inventing a second convention for "where is zero".
//
// This is a DISPLAY zero, not the solver's zero: the Rust residual measures
// roll about the axis frozen at problem-build time (`seed_axes`,
// mate_residuals.rs), which this module has no access to -- only the solved
// anchor pose reaches the frontend. The two references agree in the common
// case (the anchor axis direction is unchanged since the mate was authored)
// but can diverge if a later edit redefines ref_a's underlying geometry so its
// axis convention flips or rotates. Out of scope to reconcile here: doing so
// would mean plumbing the seed axis itself across the wire.

import { deriveAnchorFrame } from '@/utils/anchorGizmos'
import { normalize } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

export interface RollGuide {
  point: Vec3
  /** World-space polyline from zero roll to `angleDeg`, inclusive of both ends. */
  arc: Vec3[]
  /** The arc's far end -- where a guide arrowhead would sit. */
  tip: Vec3
}

const SEGMENTS_PER_TURN = 24

/**
 * `angleDeg` may be any finite value; the arc simply winds past a full turn if
 * asked to (the UI's own +/-180 guard is a separate, earlier check). A
 * degenerate axis (zero-length) yields no guide rather than NaN points.
 */
export function buildRollGuide(point: Vec3, axis: Vec3, angleDeg: number, radius: number): RollGuide | null {
  const primary = normalize(axis)
  if (!primary || !Number.isFinite(angleDeg)) return null

  const frame = deriveAnchorFrame(primary)
  const zero = frame[1]
  const perp = frame[2]

  const rad = (angleDeg * Math.PI) / 180
  const steps = Math.max(1, Math.round((SEGMENTS_PER_TURN * Math.abs(angleDeg)) / 360))

  const arc: Vec3[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (rad * i) / steps
    const c = Math.cos(t)
    const s = Math.sin(t)
    const dir: Vec3 = [
      zero[0] * c + perp[0] * s,
      zero[1] * c + perp[1] * s,
      zero[2] * c + perp[2] * s,
    ]
    arc.push([point[0] + dir[0] * radius, point[1] + dir[1] * radius, point[2] + dir[2] * radius])
  }

  return { point, arc, tip: arc[arc.length - 1] }
}
