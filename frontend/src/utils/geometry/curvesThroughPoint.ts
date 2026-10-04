import type { Sketch, Entity, LineSegment, Circle, Arc } from '@/types/cad'
import { getEntityKind } from '@/types/cad'

/** True when `pt` lies within the arc's CCW swept span [angle_start, angle_end]
 *  (degrees), with an angular slack matching the radial tolerance so a contact
 *  sitting exactly on an endpoint still counts. The point is assumed already on
 *  the circle (radius checked by the caller). */
function pointOnArcSpan(a: Arc, px: number, py: number, tol: number): boolean {
  const angDeg = (Math.atan2(py - a.center[1], px - a.center[0]) * 180) / Math.PI
  // A full turn (a nonzero multiple of 360) folds to 0 under the modulo and would
  // read as an empty span, admitting only angles near the start. Treat it as the
  // full circle it is; a genuine zero sweep keeps its empty span.
  const delta = a.angle_end - a.angle_start
  const full = delta !== 0 && delta % 360 === 0
  const span = full ? 360 : (((delta % 360) + 360) % 360)
  const rel = (((angDeg - a.angle_start) % 360) + 360) % 360
  // Arc-length tol -> angular slack; a degenerate (near-zero) radius admits any angle.
  const slack = a.radius > tol ? ((tol / a.radius) * 180) / Math.PI : 360
  return rel <= span + slack || rel >= 360 - slack
}

/**
 * Entity ids whose locus passes within `tol` of `pt`, using the same point-on-
 * curve forms the solver's `coincident` enforces: perpendicular distance to the
 * infinite line for a segment, and `|dist(pt, center) - radius|` for a circle.
 * This is the geometric fallback that decides which curves a materialized
 * intersection point should be pinned to when the topology record does not carry
 * the contributing entity ids.
 *
 * An arc must also lie within its swept span -- this fallback runs precisely when
 * the topology record is absent, so a point on the full-circle locus but off the
 * arc's span must NOT be returned (it would author a coincident the arc cannot
 * satisfy). Ellipse and spline loci are intentionally not handled here -- their
 * conic/Bezier membership is better taken from the topology record.
 */
export function curvesThroughPoint(sketch: Sketch, pt: [number, number], tol: number): string[] {
  const [px, py] = pt
  const out: string[] = []
  for (const [id, entity] of Object.entries(sketch)) {
    const kind = getEntityKind(entity as Entity)
    if (kind === 'line') {
      const l = entity as LineSegment
      const dx = l.end[0] - l.start[0]
      const dy = l.end[1] - l.start[1]
      const n = Math.hypot(dx, dy)
      if (n < 1e-12) continue
      // Perpendicular distance to the infinite line (matches r_coincident line).
      const perp = Math.abs((px - l.start[0]) * (-dy / n) + (py - l.start[1]) * (dx / n))
      if (perp < tol) out.push(id)
    } else if (kind === 'circle') {
      const c = entity as Circle
      const d = Math.hypot(px - c.center[0], py - c.center[1])
      if (Math.abs(d - c.radius) < tol) out.push(id)
    } else if (kind === 'arc') {
      const a = entity as Arc
      const d = Math.hypot(px - a.center[0], py - a.center[1])
      if (Math.abs(d - a.radius) < tol && pointOnArcSpan(a, px, py, tol)) out.push(id)
    }
  }
  return out
}
