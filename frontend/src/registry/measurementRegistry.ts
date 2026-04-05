import type { LineSegment, Arc, Circle, PointEntity } from '../types/cad'

/**
 * Measurement Registry — defines measurement rules in order of specificity.
 * First matching rule wins. More specific measurements are listed first.
 */

export interface SingleEntityRule {
  label: string
  evaluate: (entity: Arc | Circle | LineSegment | PointEntity) => string[]
}

export interface MultiEntityRule {
  label: string
  evaluate: (entities: {
    line?: LineSegment
    line1?: LineSegment
    line2?: LineSegment
    arc?: Arc
    arc1?: Arc
    arc2?: Arc
    point?: PointEntity
    point1?: PointEntity
    point2?: PointEntity
  }) => string[]
}

/**
 * Single entity rules: specific measurements (first match wins)
 */
export const SINGLE_ENTITY_RULES: readonly SingleEntityRule[] = [
  // Circle: specific radius measurement
  {
    label: 'Circle radius',
    evaluate: (entity) => {
      const e = entity as unknown as Record<string, unknown>
      if (!('center' in e && 'radius' in e && !('angle_start' in e))) return []
      const circle = entity as Circle
      const r = circle.radius || 0
      return [`[CIRCLE] r=${r.toFixed(2)} mm`]
    },
  },
  // Arc: specific sweep and radius
  {
    label: 'Arc sweep',
    evaluate: (entity) => {
      const e = entity as unknown as Record<string, unknown>
      if (!('center' in e && 'radius' in e && 'angle_start' in e)) return []
      const arc = entity as Arc
      const r = arc.radius || 0
      const sweep = arc.angle_end - arc.angle_start
      return [`[ARC] r=${r.toFixed(2)} mm, θ=${Math.abs(sweep).toFixed(0)}°`]
    },
  },
  // Line: length
  {
    label: 'Line length',
    evaluate: (entity) => {
      const e = entity as unknown as Record<string, unknown>
      if (!('start' in e && 'end' in e && !('radius' in e))) return []
      const line = entity as LineSegment
      const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1])
      return [`[LINE] ${length.toFixed(2)} mm`]
    },
  },
  // Point: no measurement (vertices are not shown)
  {
    label: 'Point',
    evaluate: () => {
      return []
    },
  },
]

/**
 * Multi-entity rules: pair-based measurements
 */
export const MULTI_ENTITY_RULES: readonly MultiEntityRule[] = [
  // Line-point normal distance
  {
    label: 'Point to line distance',
    evaluate: (entities) => {
      const line = entities.line || entities.line1
      const point = entities.point || entities.point1
      if (!line || !point) return []
      const [lx0, ly0] = line.start
      const [lx1, ly1] = line.end
      const px = point.x
      const py = point.y
      const lX = lx1 - lx0
      const lY = ly1 - ly0
      const lLen2 = lX * lX + lY * lY
      if (lLen2 < 1e-10) return []
      const t = Math.max(0, Math.min(1, ((px - lx0) * lX + (py - ly0) * lY) / lLen2))
      const closestX = lx0 + t * lX
      const closestY = ly0 + t * lY
      const dist = Math.hypot(px - closestX, py - closestY)
      return [`point-line distance: ${dist.toFixed(2)} mm`]
    },
  },
  // Line-line angle (including parallel distance)
  {
    label: 'Line angle',
    evaluate: (entities) => {
      const line1 = entities.line1 as LineSegment | undefined
      const line2 = entities.line2 as LineSegment | undefined
      if (!line1 || !line2) return []
      const [ax0, ay0] = line1.start
      const [ax1, ay1] = line1.end
      const [bx0, by0] = line2.start
      const [bx1, by1] = line2.end
      const lX = ax1 - ax0
      const lY = ay1 - ay0
      const bX = bx1 - bx0
      const bY = by1 - by0
      const lLen = Math.hypot(lX, lY)
      const bLen = Math.hypot(bX, bY)
      if (lLen <= 0 || bLen <= 0) return []
      const dot = lX * bX + lY * bY
      const cross = lX * bY - lY * bX
      const parallel = Math.abs(cross) < 1e-6
      if (parallel) {
        const dist = Math.abs((bx0 - ax0) * (-lY) + (by0 - ay0) * lX) / lLen
        return [`parallel lines, distance: ${dist.toFixed(2)} mm`]
      }
      let angle = Math.acos(Math.max(-1, Math.min(1, dot / (lLen * bLen))))
      // Always show acute angle (< 90°)
      const halfPi = Math.PI / 2
      if (angle > halfPi) {
        angle = Math.PI - angle
      }
      return [`angle: ${(angle * 180 / Math.PI).toFixed(1)}°`]
    },
  },
  // Arc-arc center distance
  {
    label: 'Arc center distance',
    evaluate: (entities) => {
      const arc1 = entities.arc1 as Arc | undefined
      const arc2 = entities.arc2 as Arc | undefined
      if (!arc1 || !arc2) return []
      const centerA = arc1.center
      const centerB = arc2.center
      const dist = Math.hypot(centerB[0] - centerA[0], centerB[1] - centerA[1])
      return [`arc-center dist: ${dist.toFixed(2)} mm`]
    },
  },
  // Point-point distance
  {
    label: 'Point distance',
    evaluate: (entities) => {
      const p1 = entities.point1 as PointEntity | undefined
      const p2 = entities.point2 as PointEntity | undefined
      if (!p1 || !p2) return []
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      if (dist <= 0.01) return []
      return [`dist: ${dist.toFixed(2)} mm`]
    },
  },
]

/**
 * Measure a single entity using all single-entity rules.
 * First matching rule wins.
 */
export function measureSingleEntity(
  entity: Arc | Circle | LineSegment | PointEntity
): string[] {
  for (const rule of SINGLE_ENTITY_RULES) {
    if (rule.evaluate(entity).length > 0) {
      return rule.evaluate(entity)
    }
  }
  return []
}

/**
 * Measure a pair of entities using all multi-entity rules.
 * First matching rule wins.
 */
export function measurePair(
  entities: {
    line1?: LineSegment
    line2?: LineSegment
    arc1?: Arc
    arc2?: Arc
    point1?: PointEntity
    point2?: PointEntity
  }
): string[] {
  for (const rule of MULTI_ENTITY_RULES) {
    if (rule.evaluate(entities).length > 0) {
      return rule.evaluate(entities)
    }
  }
  return []
}
