// PURE LOGIC -- no Three.js, no React, no registry. Imports nothing on purpose:
// the kernel drag fast-path (kernel/features/sketch.ts) needs this math inside
// the worker, where the solver core is 'blind and deaf'. Keep it dependency-free.

// The 4 ellipse control points: positive/negative ends of the major and minor
// axes. These vertex keys are shared across query resolution (geometryMapping),
// constraint lowering (lowerSketch SEL_CODE / partDocToSketches), picking, and
// rendering -- and mirror PointSelector Major/MajorNeg/Minor/MinorNeg in the
// Rust solver. A point_distance from 'center' to 'major1'/'minor1' dimensions
// the major/minor radius.
export const ELLIPSE_AXIS_KEYS = ['major1', 'major2', 'minor1', 'minor2'] as const
export type EllipseAxisKey = typeof ELLIPSE_AXIS_KEYS[number]

export function isEllipseAxisKey(key: string): key is EllipseAxisKey {
  return (ELLIPSE_AXIS_KEYS as readonly string[]).includes(key)
}

/** The 4 axis endpoints of an ellipse, derived from center/a/b/theta(deg). */
export function ellipseAxisPoints(
  cx: number, cy: number, a: number, b: number, thetaDeg: number,
): Record<EllipseAxisKey, [number, number]> {
  const th = thetaDeg * (Math.PI / 180)
  const ct = Math.cos(th), st = Math.sin(th)
  return {
    major1: [cx + a * ct, cy + a * st],
    major2: [cx - a * ct, cy - a * st],
    minor1: [cx - b * st, cy + b * ct],
    minor2: [cx + b * st, cy - b * ct],
  }
}

/** Smallest semi-axis a drag may leave behind. A zero axis collapses the ellipse
 *  to a segment, which the solver cannot recover from (theta stops being
 *  observable), so the handles clamp instead of passing through zero. */
const MIN_SEMI_AXIS = 1e-6

/** Map a cursor drop position onto an ellipse's (a, b, theta) params.
 *
 *  The 4 axis endpoints are derived from center/a/b/theta, not stored params, so
 *  a drag on one cannot write an XY pair the way `VERTEX_INDICES` drags do -- it
 *  must be inverted back into the params that place the handle under the cursor.
 *  Same shape as the arc start/end drag, which inverts into radius + angle.
 *
 *  The two handle families behave differently on purpose, matching how the
 *  handles read on screen:
 *   - a major handle both resizes and rotates (it is the axis direction), so it
 *     lands exactly on the cursor;
 *   - a minor handle only resizes, sliding along the fixed minor direction, so
 *     the cursor's off-axis component is projected away. Letting it rotate too
 *     would make the ellipse spin whenever the user nudged the handle sideways.
 *
 *  `params` is the live [cx, cy, a, b, theta(deg)] block -- for a drag frame the
 *  warm start, so theta stays on its current branch across the atan2 seam.
 *  Returns null when the cursor sits on the center, where a major handle has no
 *  direction to point at; the caller holds the last good params. */
export function ellipseAxisDrag(
  params: readonly number[],
  key: EllipseAxisKey,
  to: readonly [number, number],
): { a: number; b: number; theta: number } | null {
  const [cx, cy, a, b, theta] = params
  const dx = to[0] - cx
  const dy = to[1] - cy

  if (key === 'major1' || key === 'major2') {
    const r = Math.hypot(dx, dy)
    if (r < MIN_SEMI_AXIS) return null
    // major2 is the negative end, so it points the axis the opposite way.
    const sign = key === 'major1' ? 1 : -1
    let ang = (Math.atan2(sign * dy, sign * dx) * 180) / Math.PI
    // Keep theta on the warm-start branch (atan2 wraps at +/-180) so crossing
    // the seam does not spin the ellipse by a full turn.
    ang += Math.round((theta - ang) / 360) * 360
    return { a: r, b, theta: ang }
  }

  // Minor handles: theta is fixed, so b is the cursor's distance along the minor
  // direction v = (-sin, cos). Projecting (rather than taking |cursor - center|)
  // is what makes the handle slide along the axis instead of chasing the cursor.
  const th = theta * (Math.PI / 180)
  const proj = -dx * Math.sin(th) + dy * Math.cos(th)
  return { a, b: Math.max(Math.abs(proj), MIN_SEMI_AXIS), theta }
}
