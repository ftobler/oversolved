// PURE LOGIC -- no Three.js, no React. The feature-handle drag mapping:
// project the cursor ray onto the handle's world axis and convert the travel
// to a field value. Kept renderer-free so it unit-tests without a viewport.

import { COLOR_HOVER, COLOR_PREVIEW_EDGE } from '@/utils/core/partColors'

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

/**
 * World length of the arrow's tail behind the grab point, so the arrow spans
 * the whole feature: a linear handle's anchor sits `value * unitScale` world
 * units from the feature origin (extrude: profile plane, symmetric extrude:
 * mid-plane via unitScale 0.5, fillet/chamfer: picked edge), so that distance
 * is exactly the tail. Angular handles get no tail: a straight shaft would
 * misrepresent the sweep arc, so they keep the short fixed-size arrow.
 */
export function handleTailLength(
  kind: 'linear' | 'angular',
  value: number,
  unitScale: number,
): number {
  if (kind !== 'linear') return 0
  return Math.max(0, value * unitScale)
}

/**
 * Screen-px offset of the value label's CENTER from the arrow tip, placing
 * the label just past the tip along the arrow's projected screen direction.
 * The support term (halfW*|sx| + halfH*|sy|) pushes the label's own box fully
 * clear of the tip whichever way the arrow points; when the arrow is seen
 * end-on (projected direction ~ zero) the label sits above the tip instead
 * of on top of the cone. Screen y grows downward.
 */
export function labelOffsetPx(
  screenDir: readonly [number, number],
  halfW: number,
  halfH: number,
  gap: number,
): [number, number] {
  const len = Math.hypot(screenDir[0], screenDir[1])
  if (len < 1e-6) return [0, -(gap + halfH)]
  const sx = screenDir[0] / len
  const sy = screenDir[1] / len
  const support = halfW * Math.abs(sx) + halfH * Math.abs(sy)
  return [sx * (gap + support), sy * (gap + support)]
}

/**
 * Arrow (shaft, cone, label) color. At rest the handle wears the same violet as
 * the preview wireframe it drives, so the arrow reads as part of the preview
 * rather than as a selected entity. Hover and drag brighten it to white, the
 * project-wide "you are touching this" signal.
 */
export function handleColor(hovered: boolean, dragging: boolean): string {
  return hovered || dragging ? COLOR_HOVER : COLOR_PREVIEW_EDGE
}
