// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'

export { CLICK_THRESHOLD_PX }

/** A pointer event after coordinate sanitization by the abstraction layer.
 *  All downstream consumers (selection subsystem, tool layer) operate on
 *  sketch-local 2D coords and screen pixel coords -- never on raw 3D world space.
 *
 *  Produced by makeSanitizedEvent() or the adapter sanitizePointerEvent(). Null means off-plane. */
export interface SanitizedPointerEvent {
  // Sketch-local 2D coordinates of the hit point.
  localPoint: [number, number]
  // Screen pixel coordinates at event time, used for click-vs-drag disambiguation.
  clientPoint: [number, number]
}

/** Wrap an already-transformed local point into the abstraction type.
 *  Returns null when the local Z component indicates an off-plane hit (|z| > 1),
 *  which signals the raycast landed on an HTML overlay rather than sketch geometry,
 *  or when any coordinate is non-finite (a degenerate transform chain). */
export function makeSanitizedEvent(
  localXYZ: readonly [number, number, number],
  clientPoint: readonly [number, number],
): SanitizedPointerEvent | null {
  // A non-finite component means the transform chain produced garbage (a
  // degenerate plane, a zeroed quaternion, a ray parallel to the plane that
  // slipped past its own guard). Refusing here keeps NaN/Infinity out of the
  // draw buffer and out of the YAML; the callers fail loud on null.
  if (!isFiniteSketchPoint([localXYZ[0], localXYZ[1]]) || !Number.isFinite(localXYZ[2])) return null
  if (Math.abs(localXYZ[2]) > 1) return null
  return {
    localPoint: [localXYZ[0], localXYZ[1]],
    clientPoint: [clientPoint[0], clientPoint[1]],
  }
}

/** Both components finite. The gate every sketch-space coordinate passes
 *  before it can reach a mutation. */
export function isFiniteSketchPoint(p: readonly [number, number]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1])
}

/** Pixel distance between two screen-space points.
 *  Used for click-vs-drag disambiguation against CLICK_THRESHOLD_PX. */
export function screenPixelDistance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** True when the pointer moved less than CLICK_THRESHOLD_PX pixels -- treat as a click, not a drag. */
export function isPureClick(startClient: readonly [number, number], endClient: readonly [number, number]): boolean {
  return screenPixelDistance(startClient, endClient) < CLICK_THRESHOLD_PX
}
