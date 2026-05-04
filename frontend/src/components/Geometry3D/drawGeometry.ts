// PURE GEOMETRY -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
import type { Sketch, Entity } from '../../types/cad'
import { getEntityBounds } from '../sketch_helpers'
import { sampleArc, sampleArcCCW } from '../sketch_helpers'

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
export function arcAnglesFromRadiusPoint(
  cx: number, cy: number,
  start: readonly [number, number], end: readonly [number, number], radiusPt: readonly [number, number]
): [number, number] {
  const toDeg = (a: number) => a * (180 / Math.PI)
  const norm = (a: number) => ((a % 360) + 360) % 360
  const aStart = toDeg(Math.atan2(start[1] - cy, start[0] - cx))
  const aEnd = toDeg(Math.atan2(end[1] - cy, end[0] - cx))
  const aRadius = toDeg(Math.atan2(radiusPt[1] - cy, radiusPt[0] - cx))
  const s = norm(aStart), e = norm(aEnd), rp = norm(aRadius)
  const spanCCW = ((e - s) + 360) % 360
  const rpInCCW = ((rp - s) + 360) % 360 < spanCCW
  return rpInCCW ? [aStart, aEnd] : [aEnd, aStart]
}

/** Compute preview polyline points for the current drawing tool state. */
export function computePreviewPts(
  tool: string,
  pts: [number, number][],
  hover: [number, number] | null,
): [number, number, number][] | null {
  const h = hover

  if (tool === 'line' && pts.length === 1 && h) {
    return [[pts[0][0], pts[0][1], 0], [h[0], h[1], 0]]
  }
  if (tool === 'circle' && pts.length === 1 && h) {
    const r = Math.hypot(h[0] - pts[0][0], h[1] - pts[0][1])
    return sampleArc(pts[0][0], pts[0][1], r, 0, 0)
  }
  if (tool === 'arc' && pts.length === 2 && h) {
    const cc = circumcircle(pts[0], pts[1], h)
    if (cc) {
      const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], h)
      return sampleArcCCW(cc.cx, cc.cy, cc.r, aStart, aEnd)
    }
    return [[pts[0][0], pts[0][1], 0], [pts[1][0], pts[1][1], 0]]
  }
  if (tool === 'arc' && pts.length === 1 && h) {
    return [[pts[0][0], pts[0][1], 0], [h[0], h[1], 0]]
  }
  if (tool === 'rect' && pts.length === 1 && h) {
    const [x0, y0] = pts[0]
    const [x1, y1] = h
    return [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 0]]
  }
  if (tool === 'center_rect' && pts.length === 1 && h) {
    const [cx, cy] = pts[0]
    const [x, y] = h
    const dx = x - cx, dy = y - cy
    const x0 = cx - dx, x1 = cx + dx
    const y0 = cy - dy, y1 = cy + dy
    return [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 0]]
  }
  return null
}

/** Calculate the bounding box extent of a sketch. */
export function sketchExtent(sketch: Sketch): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const entity of Object.values(sketch)) {
    const b = getEntityBounds(entity as Entity)
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX)
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY)
  }
  return isFinite(minX) ? Math.max(maxX - minX, maxY - minY, 0.01) : 1
}

/** Find all entity IDs in the sketch that have a vertex at the given point (within eps). */
export function findEntitiesAtPoint(sketch: Sketch, pt: [number, number], eps = 1e-4): string[] {
  const [px, py] = pt
  const near = (x: number, y: number) => Math.abs(x - px) <= eps && Math.abs(y - py) <= eps
  const ids: string[] = []
  for (const [eid, entity] of Object.entries(sketch)) {
    const e = entity as Entity
    if ('start' in e && 'end' in e) {
      if (near(e.start[0], e.start[1]) || near(e.end[0], e.end[1])) ids.push(eid)
    } else if ('x' in e) {
      if (near(e.x, e.y)) ids.push(eid)
    } else if ('center' in e) {
      if (near(e.center[0], e.center[1])) ids.push(eid)
    }
  }
  return ids
}
