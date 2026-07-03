// PURE LOGIC -- no Three.js, no React. The feature-handle drag mapping:
// project the cursor ray onto the handle's world axis and convert the travel
// to a field value. Kept renderer-free so it unit-tests without a viewport.

export type Vec3 = readonly [number, number, number]

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/**
 * Signed travel `t` along the axis line `axisOrigin + t * axisDir` of the
 * point on the axis closest to the cursor ray. This is the standard
 * closest-point-between-two-lines solve; it degrades gracefully when the
 * cursor is off the axis (the drag follows the axis-parallel component of
 * the cursor motion). Returns null when ray and axis are near-parallel
 * (axis seen end-on: travel along it is unobservable, so the drag must
 * hold its last value rather than jump).
 *
 * Directions need not be unit length; the parameter is in `axisDir` units,
 * so callers pass the descriptor's unit direction to get world units.
 */
export function closestAxisParam(
  rayOrigin: Vec3,
  rayDir: Vec3,
  axisOrigin: Vec3,
  axisDir: Vec3,
): number | null {
  // Degenerate inputs: a zero-length axis has no direction to travel along,
  // and a zero-length ray can't form a closest-point solve. Both must hold
  // their last value rather than produce NaN.
  const a = dot(axisDir, axisDir)
  // Degenerate inputs: a zero-length axis has no direction to travel along,
  // and a zero-length ray can't form a closest-point solve. Both must hold
  // their last value rather than produce NaN.
  if (a < 1e-12) return null
  const c = dot(rayDir, rayDir)
  if (c < 1e-12) return null
  const w = sub(axisOrigin, rayOrigin)
  const b = dot(axisDir, rayDir)
  const d = dot(w, axisDir)
  const e = dot(w, rayDir)
  const denom = a * c - b * b
  // Near-parallel threshold, scaled so it is invariant to direction lengths.
  if (denom < 1e-9 * a * c) return null
  return (b * e - c * d) / denom
}

/**
 * Map axis travel (world units from the drag's reference point) to the new
 * field value: value = start + travel / unitScale, clamped to [min, max].
 */
export function handleValueFromTravel(
  startValue: number,
  travelWorld: number,
  unitScale: number,
  min: number,
  max?: number,
): number {
  // A zero unit scale (e.g. a degenerate symmetric extrude of zero width)
  // would make travel unscaled; hold the start value instead of going Infinity.
  if (unitScale === 0) return startValue
  let v = startValue + travelWorld / unitScale
  if (v < min) v = min
  if (max !== undefined && v > max) v = max
  return v
}

/** Commit rounding: two decimals, matching the handle's min step of 0.01. */
export function roundHandleValue(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * Pure release-decision for the handle drag. The currentValue is already
 * clamped to [min, max] by handleValueFromTravel, so this only decides whether
 * the drag moved the value far enough to round to a distinct commit (sub-
 * centesimal micro-drags are no-ops, so a slip of the finger doesn't fire a
 * rebuild). Returns the value to commit, or null to skip the commit.
 */
export function shouldCommitHandleRelease(
  startValue: number,
  currentValue: number,
): number | null {
  const rounded = roundHandleValue(currentValue)
  return rounded !== roundHandleValue(startValue) ? rounded : null
}
