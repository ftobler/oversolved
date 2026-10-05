// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// The click-vs-drag primitives live here, below both the component pointer
// abstraction and the gesture tracker, so neither layer imports the other for
// them. The threshold is defined here rather than in the geometry constants:
// the constants module is part of the UI tree and must not be a dependency of
// the headless gesture logic.

/** Screen-pixel travel below which a pointer gesture counts as a click. */
export const CLICK_THRESHOLD_PX = 4

/** Pixel distance between two screen-space points.
 *  Used for click-vs-drag disambiguation against CLICK_THRESHOLD_PX. */
export function screenPixelDistance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** True when the pointer moved less than CLICK_THRESHOLD_PX pixels -- treat as a click, not a drag. */
export function isPureClick(startClient: readonly [number, number], endClient: readonly [number, number]): boolean {
  return screenPixelDistance(startClient, endClient) < CLICK_THRESHOLD_PX
}
