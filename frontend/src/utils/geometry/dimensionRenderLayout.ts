// PURE LOGIC -- no Three.js, no React. Importable in a plain vitest test.
// Layout math shared by the dimension renderers (Linear.tsx, Radial.tsx,
// Angle.tsx): where a dragged/default label sits relative to the dimension
// geometry, which drives the inside-vs-outside arrow arrangement, and how an
// extension/witness line touches its source entity. Extracted so this
// branching logic -- previously inline in the R3F components with no test
// importing the real implementation (see review-06b) -- gets the same
// table-driven coverage as its siblings (angleDimensionLogic.ts,
// dimensionNaturalValue.ts).

/** Where a label sits along a straight dimension line d1->d2, and the line's
 *  own direction/length. `isInside` mirrors Linear.tsx's arrow arrangement:
 *  true when the label projects between d1 and d2 (arrows point outward from
 *  the boundaries), false when it projects beyond either end (both arrows
 *  point inward, with a leader to whichever end is nearer -- `tLabel < 0`
 *  picks d1, otherwise d2). A zero-length dimension line (d1 === d2) has no
 *  direction to project onto; it defaults to the +X axis and reports
 *  `isInside` at `tLabel === 0`, matching every other degenerate-axis
 *  fallback in this codebase (never NaN).
 */
export interface LinearArrowLayout {
  dimLen: number
  udirX: number
  udirY: number
  tLabel: number
  isInside: boolean
}

export function computeLinearArrowLayout(
  d1: [number, number], d2: [number, number], label: [number, number],
): LinearArrowLayout {
  const [d1x, d1y] = d1, [d2x, d2y] = d2, [labelX, labelY] = label
  const dimLen = Math.hypot(d2x - d1x, d2y - d1y)
  const udirX = dimLen > 0 ? (d2x - d1x) / dimLen : 1
  const udirY = dimLen > 0 ? (d2y - d1y) / dimLen : 0
  const tLabel = (labelX - d1x) * udirX + (labelY - d1y) * udirY
  const isInside = tLabel >= 0 && tLabel <= dimLen
  return { dimLen, udirX, udirY, tLabel, isInside }
}

/** Whether an extension line from a measured entity's segment to a
 *  dimension-line endpoint (dx, dy) is needed, and where it touches the
 *  segment. Skipped when the segment is degenerate (zero length -- nothing to
 *  project onto, so the touch point is just the segment's own point) or when
 *  the dimension-line endpoint already projects onto the segment within
 *  floating-point tolerance (the dimension already crosses the entity).
 */
export interface ExtensionLineEval {
  skip: boolean
  touchX: number
  touchY: number
}

export function evalExtensionLine(
  lx1: number, ly1: number, lx2: number, ly2: number, dx: number, dy: number,
): ExtensionLineEval {
  const edx = lx2 - lx1, edy = ly2 - ly1
  const elen2 = edx * edx + edy * edy
  if (elen2 < 1e-12) return { skip: true, touchX: lx1, touchY: ly1 }
  let t = ((dx - lx1) * edx + (dy - ly1) * edy) / elen2
  t = Math.max(0, Math.min(1, t))
  const nx = lx1 + t * edx, ny = ly1 + t * edy
  const d2 = (dx - nx) * (dx - nx) + (dy - ny) * (dy - ny)
  return d2 < 0.001 ? { skip: true, touchX: nx, touchY: ny } : { skip: false, touchX: nx, touchY: ny }
}

/** Whether a radial/diameter dimension's label sits within its circle
 *  (arrows point outward from the boundary) or beyond it (arrows point
 *  inward, with a leader to the label). A collapsed circle (r === 0) reads as
 *  inside only when the label sits exactly at the center too -- same
 *  comparison as every other radius, no special case.
 */
export function isPointInsideRadius(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return Math.hypot(px - cx, py - cy) <= r
}

/** Where an angle dimension's radial witness line starts on its measured
 *  ray, or null when none is needed. The measured segment (px1,py1)-(px2,py2)
 *  lies along the ray from the vertex (vx, vy) at angle `ang`; its signed
 *  distances from the vertex along that ray span [sMin, sMax]. The arc sits
 *  at radius `arcR`: when that falls inside [sMin, sMax] the arc already
 *  touches the segment and no witness is drawn (null); otherwise the witness
 *  starts at whichever span boundary is nearer the arc, and the caller draws
 *  it out to the arc endpoint.
 */
export function radialWitnessStart(
  vx: number, vy: number, arcR: number,
  px1: number, py1: number, px2: number, py2: number, ang: number,
): [number, number] | null {
  const dx = Math.cos(ang), dy = Math.sin(ang)
  const s1 = (px1 - vx) * dx + (py1 - vy) * dy
  const s2 = (px2 - vx) * dx + (py2 - vy) * dy
  const sMax = Math.max(s1, s2), sMin = Math.min(s1, s2)
  let b: number | null = null
  if (arcR > sMax) b = sMax
  else if (arcR < sMin) b = sMin
  if (b === null) return null
  return [vx + b * dx, vy + b * dy]
}

/**
 * The rotation, in degrees, that lays a dimension's value along its line the
 * way drafting does: parallel to the line, folded so it never reads upside
 * down. `screenDx`/`screenDy` are CSS pixel axes (x right, y down), so the
 * result is exactly what `transform: rotate(<deg>deg)` wants and a positive
 * value tilts the text clockwise on screen.
 *
 * The fold is the half-open range [-90, 90): a line traversed right to left
 * lands on the same slope as left to right, and either vertical direction
 * reads bottom to top (-90), so the exact vertical case is pinned rather than
 * flipping with the traversal direction. A line within 1e-9 of its own length
 * of vertical (about 6e-8 degrees) is pinned the same way: at the fold's
 * boundary a 1e-16 pixel of projection noise would otherwise flip the text 180
 * degrees.
 */
export function readableLabelAngle(screenDx: number, screenDy: number): number {
  if (!Number.isFinite(screenDx) || !Number.isFinite(screenDy)) return 0
  if (screenDx === 0 && screenDy === 0) return 0
  if (Math.abs(screenDx) <= 1e-9 * Math.abs(screenDy)) return -90
  let deg = (Math.atan2(screenDy, screenDx) * 180) / Math.PI
  while (deg < -90) deg += 180
  while (deg >= 90) deg -= 180
  return deg
}

/** One drawable span of a dimension line, in sketch-plane coordinates. */
export type LineSegment2D = [[number, number], [number, number]]

/**
 * Split a linear dimension's line d1 -> d2 around the value's text, returning
 * the spans that stay drawn: two when the gap lands inside the line, one when
 * the line is not cut, and none when the text is wider than the line (the
 * arrows at the ends stay).
 *
 * The line is cut only when the label sits ON it: inside the d1..d2 span and
 * within `perpToleranceWorld` of the line (about half the rendered text
 * height). A label dragged off to the side, or an outside label sitting on its
 * leader, keeps the whole line. The cut is centred on the label's projection
 * onto the line, `gapWorld / 2` either side, and clamped at the ends so a
 * label at d1 or d2 leaves the one surviving span instead of a reversed one.
 * A zero-length line has nowhere to cut and no direction to cut along, so it
 * returns no spans.
 */
export function dimensionLineGap(
  d1: [number, number], d2: [number, number], label: [number, number],
  gapWorld: number, perpToleranceWorld: number,
): LineSegment2D[] {
  const [d1x, d1y] = d1, [d2x, d2y] = d2, [labelX, labelY] = label
  const dimLen = Math.hypot(d2x - d1x, d2y - d1y)
  if (dimLen === 0) return []
  if (!(gapWorld > 0)) return [[d1, d2]]

  const { tLabel, isInside } = computeLinearArrowLayout(d1, d2, label)
  if (!isInside) return [[d1, d2]]
  const ux = (d2x - d1x) / dimLen, uy = (d2y - d1y) / dimLen
  const perp = Math.abs((labelX - d1x) * uy - (labelY - d1y) * ux)
  if (perp > perpToleranceWorld) return [[d1, d2]]
  if (gapWorld >= dimLen) return []

  const at = (t: number): [number, number] => [d1x + ux * t, d1y + uy * t]
  const half = gapWorld / 2
  const tA = Math.max(0, tLabel - half)
  const tB = Math.min(dimLen, tLabel + half)
  const segs: LineSegment2D[] = []
  if (tA > 0) segs.push([d1, at(tA)])
  if (tB < dimLen) segs.push([at(tB), d2])
  return segs
}
