// PURE LOGIC -- no Three.js, no React, no WASM.
// Policy for choosing what a circle rim drag does the moment the drag activates.
// The numeric thresholds live here (not inside the solver call) so the mode
// decision is unit-testable without WASM. The probe itself (which runs the real
// drag solver) lives in kernel/features/sketch.ts and delegates the verdict to
// resolveDragMode.

export type CircleDragMode = 'translate' | 'radius' | 'locked'

// Relative probe step: a fraction of the circle radius rather than a fixed
// absolute unit. The solver's tolerances and the sketch's units both scale, so a
// fixed step would be wrong on a 0.5 mm hole and on a 500 mm flange at once.
export const PROBE_STEP_REL = 0.1

// A centre that is technically free by rank but sits in a stiff constraint web
// still reads as "mobile" and then visibly refuses to move under the actual drag
// solve; the margin below is wide (free response ~1, pinned response ~0).
export const TRANSLATE_RESPONSE_MIN = 0.25

// Same reasoning as the translate threshold: a free radius responds near 1, a
// radius pinned by a dimension responds near 0.
export const RADIUS_RESPONSE_MIN = 0.25

export interface DragModeResponses {
  // Fractional centre response to a unit probe along +X (0 = pinned, 1 = free).
  translateX: number
  // Fractional centre response to a unit probe along +Y.
  translateY: number
  // Fractional radius response to a relative (PROBE_STEP_REL) radius probe.
  radius: number
}

/** Decide the drag mode from measured solver responses. The thresholds are
 *  exclusive at the boundary: a response exactly equal to the minimum is NOT
 *  mobile (see the test "thresholds are exclusive at the boundary"). The max of
 *  the two orthogonal translate responses wins, so a centre free along only one
 *  axis (on a line, on a horizontal constraint) still reads as mobile instead of
 *  being misclassified by a single along-axis probe. */
export function resolveDragMode(r: DragModeResponses): CircleDragMode {
  const centreMobile = Math.max(r.translateX, r.translateY) > TRANSLATE_RESPONSE_MIN
  if (centreMobile) return 'translate'
  if (r.radius > RADIUS_RESPONSE_MIN) return 'radius'
  return 'locked'
}
