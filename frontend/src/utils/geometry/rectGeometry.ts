// PURE 2D rectangle math -- no Three.js / React / registry deps, so the draw
// click logic and the doc writer share one degenerate-rect rule without either
// importing the other's layer.

/** A rectangle needs a real extent on BOTH axes. Collapsing one axis is already
 *  degenerate: an axis-aligned "rectangle" is two zero-length lines plus a
 *  coincident pair on top of each other, which pollutes the document with
 *  geometry that can never solve. Non-finite corners are broken pointer math
 *  upstream and would carry the NaN straight into the seed. */
export function isProperRect(x0: number, y0: number, x1: number, y1: number): boolean {
  return [x0, y0, x1, y1].every(v => Number.isFinite(v)) && x0 !== x1 && y0 !== y1
}

/** The two diagonal corners [x0, y0, x1, y1] of a rectangle drawn from its
 *  center: (x1, y1) is the clicked corner, (x0, y0) its mirror through the
 *  center. One derivation for the draw tool's gate and the writer's lines, so
 *  both judge the same numbers. */
export function centerRectCorners(
  center: readonly [number, number],
  corner: readonly [number, number],
): [number, number, number, number] {
  const dx = corner[0] - center[0]
  const dy = corner[1] - center[1]
  return [center[0] - dx, center[1] - dy, center[0] + dx, center[1] + dy]
}
