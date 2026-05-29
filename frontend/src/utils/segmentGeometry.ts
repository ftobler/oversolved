// PURE 2D segment math -- no registry / Three.js / R3F deps, so the dimension
// resolver and the constraint renderer can share one parallel predicate without
// an import cycle.

// Tolerance for the parallel check: |cross(unit_a, unit_b)| <= eps treats the
// two unit directions as parallel. Same magnitude as the solver's angle
// comparison; tight enough to never fire on a "skew but visually parallel" pair
// the user actually wants an angle on.
export const PARALLEL_CROSS_EPS = 1e-6

/**
 * True when two segments point in (anti-)parallel directions within
 * PARALLEL_CROSS_EPS. Zero-length segments are never parallel.
 *
 * |cross(unit_a, unit_b)| = |sin(theta)|, so parallel iff close to zero.
 */
export function segmentsAreParallel(
  aStart: readonly [number, number], aEnd: readonly [number, number],
  bStart: readonly [number, number], bEnd: readonly [number, number],
): boolean {
  const ax = aEnd[0] - aStart[0]
  const ay = aEnd[1] - aStart[1]
  const bx = bEnd[0] - bStart[0]
  const by = bEnd[1] - bStart[1]
  const na = Math.hypot(ax, ay)
  const nb = Math.hypot(bx, by)
  if (na === 0 || nb === 0) return false
  return Math.abs(ax * by - ay * bx) / (na * nb) <= PARALLEL_CROSS_EPS
}
