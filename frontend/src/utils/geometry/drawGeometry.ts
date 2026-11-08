// PURE GEOMETRY -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
import type { Sketch, Entity } from '@/types/cad'
import {
  circumcircle, arcEndpointOrder, arcAnglesFromRadiusPoint,
} from '@/utils/geometry/arcFromPoints'
import { getEntityBounds } from '@/utils/geometry/sketchHelpers'
import { sampleArc, sampleArcCCW, sampleEllipse, sampleBezier } from '@/utils/geometry/sketchHelpers'
import { fitSplinePolyline } from '@/utils/geometry/fitSpline'

// The arc-from-three-points math lives in a pure sibling so the document
// writers can share it without reaching this file's sketchHelpers closure
// (which imports three for the viewport's convenience).
export { circumcircle, arcEndpointOrder, arcAnglesFromRadiusPoint }

// Default semi-minor/semi-major ratio for the two-click ellipse draw (golden
// ratio). The second click only fixes the major axis; b is seeded from a. This
// is the single source of truth -- drawLogic imports it so the preview matches
// the entity the second click commits.
export const ELLIPSE_MINOR_RATIO = 0.618

/** Vertices of a regular N-gon circumscribed by the circle through `corner`,
 *  as a closed polyline (first vertex repeated at the end). The first vertex
 *  sits at `corner`, matching the two-click n-gon draw. */
export function ngonPolyline(
  center: readonly [number, number],
  corner: readonly [number, number],
  sides: number,
): [number, number, number][] {
  const n = Math.max(3, Math.floor(sides))
  const [cx, cy] = center
  const radius = Math.hypot(corner[0] - cx, corner[1] - cy)
  const angle0 = Math.atan2(corner[1] - cy, corner[0] - cx)
  const out: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = angle0 + (i / n) * 2 * Math.PI
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), 0])
  }
  out.push(out[0])  // close the loop exactly (no float drift on the seam)
  return out
}

/** Compute preview polyline points for the current drawing tool state. */
export function computePreviewPts(
  tool: string,
  pts: [number, number][],
  hover: [number, number] | null,
  ngonSides = 6,
): [number, number, number][] | null {
  const h = hover

  if (tool === 'ngon' && pts.length === 1 && h) {
    return ngonPolyline(pts[0], h, ngonSides)
  }

  if (tool === 'line' && pts.length >= 1 && h) {
    // The line tool keeps its chain open, so the rubber band always runs from
    // the last placed point to the cursor, not only before the second point.
    const last = pts[pts.length - 1]
    return [[last[0], last[1], 0], [h[0], h[1], 0]]
  }
  if (tool === 'circle' && pts.length === 1 && h) {
    const r = Math.hypot(h[0] - pts[0][0], h[1] - pts[0][1])
    return sampleArc(pts[0][0], pts[0][1], r, 0, 0)
  }
  if (tool === 'ellipse' && pts.length === 1 && h) {
    const dx = h[0] - pts[0][0]
    const dy = h[1] - pts[0][1]
    const a = Math.hypot(dx, dy)
    const theta = Math.atan2(dy, dx) * (180 / Math.PI)
    return sampleEllipse(pts[0][0], pts[0][1], a, a * ELLIPSE_MINOR_RATIO, theta)
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
  if (tool === 'fit_spline' && h) {
    // Through the placed points plus the cursor. Fewer than two points is not
    // a curve yet; a degenerate pair (the cursor on the last point) falls back
    // to the polyline.
    const all = [...pts.map(p => [p[0], p[1]] as [number, number]), [h[0], h[1]] as [number, number]]
    const curve = fitSplinePolyline(all, undefined, undefined, 64)
    if (curve.length >= 2) return curve.map(p => [p[0], p[1], 0] as [number, number, number])
    return all.map(p => [p[0], p[1], 0] as [number, number, number])
  }
  if (tool === 'spline' && h) {
    // Build up the cubic Bezier across the 4 clicks: show the control polygon
    // while fewer than 3 points are placed, then the sampled curve once the
    // first three are down and the cursor previews the endpoint.
    if (pts.length === 1) return [[pts[0][0], pts[0][1], 0], [h[0], h[1], 0]]
    if (pts.length === 2) {
      return [[pts[0][0], pts[0][1], 0], [pts[1][0], pts[1][1], 0], [h[0], h[1], 0]]
    }
    if (pts.length === 3) return sampleBezier(pts[0], pts[1], pts[2], h)
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
    } else if ('p1' in e) {
      if (near(e.p1[0], e.p1[1]) || near(e.p4[0], e.p4[1])) ids.push(eid)
    } else if ('x' in e) {
      if (near(e.x, e.y)) ids.push(eid)
    } else if ('center' in e) {
      if (near(e.center[0], e.center[1])) ids.push(eid)
    }
  }
  return ids
}
