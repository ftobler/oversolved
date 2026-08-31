// Pure derivation of the pick pass's device-pixel ratio. Its own module rather
// than a helper inside `IdPickingDriver`, for the same reason `layerNames` is:
// the driver is an R3F component, and anything else it exports both breaks fast
// refresh and drags the Canvas into tests that only need the arithmetic.

/**
 * The smallest canvas width, in CSS pixels, this treats as a real measurement.
 * R3F reports a size of 1 before the canvas has measured, and 1 CSS px against
 * a real drawing buffer would derive a ratio in the hundreds.
 */
export const MIN_PLAUSIBLE_CANVAS_CSS_WIDTH = 16

/**
 * Device pixels per CSS pixel of the ID target. The pipeline needs it because
 * the pick window is specified in CSS pixels but read in device ones.
 *
 * Derived from the two sizes the driver already holds rather than read off
 * `gl.getPixelRatio()`, so the pipeline stays resolvable without a GL context
 * (the whole picking path is unit-tested that way). The renderer's own value
 * would be the more exact of the two -- it is what sized the drawing buffer --
 * so this is a testability trade, not an accuracy one.
 *
 * An unmeasured canvas falls back to 1. The pipeline clamps anyway, so a wild
 * ratio could only ever cost a needlessly large readback, but the nonsense is
 * recognisable here and belongs here.
 */
export function getPixelRatio(bufferWidth: number, cssWidth: number): number {
  return cssWidth >= MIN_PLAUSIBLE_CANVAS_CSS_WIDTH ? bufferWidth / cssWidth : 1
}
