// PURE GEOMETRY -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// Kept out of drawGeometry so the yamlMutations sugar and the headless module
// closure can use the arc math without pulling in sketchHelpers (which imports
// three for the viewport).

/** Compute circumcircle of 3 points. Returns null if points are collinear. */
export function circumcircle(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): { cx: number; cy: number; r: number } | null {
  const ax = p1[0], ay = p1[1]
  const bx = p2[0], by = p2[1]
  const cx = p3[0], cy = p3[1]
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-10) return null
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D
  const r = Math.hypot(ax - ux, ay - uy)
  return { cx: ux, cy: uy, r }
}

/** Given arc start and end angles (degrees) and a radius point, determine the CCW arc.
 *  Returns [aStart, aEnd] such that going CCW from aStart reaches aEnd.
 *  The radius point determines which arc (short or long) was intended. */
/** The arc's angles plus which clicked endpoint became its `start` vertex.
 *
 *  An arc is stored CCW from angle_start to angle_end, so the bulge point
 *  decides which of the two clicked ends leads. A caller that wants to say
 *  something about the FIRST clicked point (a snap on it, say) has to know
 *  whether that point is the arc's `start` vertex or its `end` vertex. */
export function arcEndpointOrder(
  cx: number, cy: number,
  start: readonly [number, number], end: readonly [number, number], radiusPt: readonly [number, number]
): { angles: [number, number]; startsAtFirst: boolean } {
  const toDeg = (a: number) => a * (180 / Math.PI)
  const norm = (a: number) => ((a % 360) + 360) % 360
  const aStart = toDeg(Math.atan2(start[1] - cy, start[0] - cx))
  const aEnd = toDeg(Math.atan2(end[1] - cy, end[0] - cx))
  const aRadius = toDeg(Math.atan2(radiusPt[1] - cy, radiusPt[0] - cx))
  const s = norm(aStart), e = norm(aEnd), rp = norm(aRadius)
  const spanCCW = ((e - s) + 360) % 360
  const rpInCCW = ((rp - s) + 360) % 360 < spanCCW
  return rpInCCW
    ? { angles: [aStart, aEnd], startsAtFirst: true }
    : { angles: [aEnd, aStart], startsAtFirst: false }
}

export function arcAnglesFromRadiusPoint(
  cx: number, cy: number,
  start: readonly [number, number], end: readonly [number, number], radiusPt: readonly [number, number]
): [number, number] {
  return arcEndpointOrder(cx, cy, start, end, radiusPt).angles
}
