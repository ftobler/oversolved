import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '../types/cad'

/**
 * Compute all possible measurement combinations for a set of selected entities.
 * Returns descriptions that can be displayed in the footer.
 */
export function computeMeasurements(
  selection: Set<string>,
  sketch: Sketch
): string[] {
  const results: string[] = []

  // Group selections by type
  const lines: LineSegment[] = []
  const arcs: Arc[] = []
  const circles: Circle[] = []
  const points: PointEntity[] = []

  for (const id of selection) {
    if (id.startsWith('@builtin_') || id.startsWith('@feature')) {
      continue
    }

    let entityId: string | undefined

    if (id.startsWith('entity:')) {
      entityId = id.slice(8)
    } else if (id.startsWith('vertex:')) {
      const parts = id.split(':')
      entityId = parts[2]
    } else {
      continue
    }

    if (!entityId) continue

    const entity = sketch[entityId]
    if (!entity) continue

    // Determine entity kind using type guards and explicit type assertions
    if ('start' in entity && 'end' in entity && 'radius' in entity) {
      arcs.push(entity as Arc)
    } else if ('start' in entity && 'end' in entity) {
      lines.push(entity as LineSegment)
    } else if ('center' in entity && 'radius' in entity) {
      circles.push(entity as Circle)
    } else if ('x' in entity) {
      points.push(entity as PointEntity)
    } else {
      continue
    }
  }

  // Single entity measurements
  for (const arc of arcs) {
    const r = arc.radius || 0
    const sweep = ((arc.angle_end - arc.angle_start) % 360)
    results.push(`[ARC] r=${r.toFixed(2)} mm, θ=${Math.abs(sweep).toFixed(0)}°`)
  }

  for (const circle of circles) {
    results.push(`[CIRCLE] r=${(circle.radius || 0).toFixed(2)} mm`)
  }

  for (const line of lines) {
    const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1])
    results.push(`[LINE] ${length.toFixed(2)} mm`)
  }

  for (const pt of points) {
    results.push(`[POINT] (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`)
  }

  // Multi-entity measurements
  // Angle between two lines
  if (lines.length >= 2) {
    for (let i = 0; i < lines.length - 1; i++) {
      const lineA = lines[i]
      const lineB = lines[i + 1]
      const [ax0, ay0] = lineA.start
      const [ax1, ay1] = lineA.end
      const [bx0, by0] = lineB.start
      const [bx1, by1] = lineB.end
      const lX = ax1 - ax0
      const lY = ay1 - ay0
      const bX = bx1 - bx0
      const bY = by1 - by0
      const lLen = Math.hypot(lX, lY)
      const bLen = Math.hypot(bX, bY)
      if (lLen > 0 && bLen > 0) {
        const dot = lX * bX + lY * bY
        const cross = lX * bY - lY * bX
        const parallel = Math.abs(cross) < 1e-6
        if (parallel) {
          results.push(`angle: parallel`)
        } else {
          const angle = Math.acos(Math.max(-1, Math.min(1, dot / (lLen * bLen))))
          results.push(`angle: ${(angle * 180 / Math.PI).toFixed(1)}°`)
        }
      }
    }
  }

  // Angle between lines and arcs
  if (lines.length > 0 && arcs.length > 0) {
    for (const line of lines) {
      const lineEnt = line
      for (const arc of arcs) {
        const arcEnt = arc
        const [lx0, ly0] = lineEnt.start
        const [lx1, ly1] = lineEnt.end
        const [ax0, ay0] = arcEnt.center
        const [ax1, ay1] = arcEnt.start
        const lX = lx1 - lx0
        const lY = ly1 - ly0
        const aX = ax1 - ax0
        const aY = ay1 - ay0
        const lLen = Math.hypot(lX, lY)
        const aLen = Math.hypot(aX, aY)
        if (lLen > 0 && aLen > 0) {
          const dot = lX * aX + lY * aY
          const angle = Math.acos(Math.max(-1, Math.min(1, dot / (lLen * aLen))))
          results.push(`angle: ${(angle * 180 / Math.PI).toFixed(1)}°`)
        }
      }
    }
  }

  // Distance between two points/vertices
  if (points.length >= 2) {
    for (let i = 0; i < points.length - 1; i++) {
      const ptA = points[i]
      const ptB = points[i + 1]
      const dist = Math.hypot(ptB.x - ptA.x, ptB.y - ptA.y)
      results.push(`dist: ${dist.toFixed(2)} mm`)
    }
  }

  return results
}
