import type { Sketch, Entity, LineSegment, Circle } from '@/types/cad'
import { getEntityKind } from '@/types/cad'

/**
 * Entity ids whose locus passes within `tol` of `pt`, using the same point-on-
 * curve forms the solver's `coincident` enforces: perpendicular distance to the
 * infinite line for a segment, and `|dist(pt, center) - radius|` for a circle or
 * arc. This is the geometric fallback that decides which curves a materialized
 * intersection point should be pinned to when the topology record does not carry
 * the contributing entity ids.
 *
 * Arcs are matched on radius only (not angular span): the topology only reports
 * contacts that actually lie on the arc, so the span check is redundant for that
 * caller. Ellipse and spline loci are intentionally not handled here -- their
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
    } else if (kind === 'circle' || kind === 'arc') {
      const c = entity as Circle  // Arc shares center/radius
      const d = Math.hypot(px - c.center[0], py - c.center[1])
      if (Math.abs(d - c.radius) < tol) out.push(id)
    }
  }
  return out
}
