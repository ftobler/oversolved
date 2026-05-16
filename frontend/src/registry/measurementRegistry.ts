// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { LineSegment, Arc, Circle, PointEntity, BodyResult, EdgeDataCircleArc } from '@/types/cad'

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
    circle?: Circle
    circle1?: Circle
    circle2?: Circle
    point?: PointEntity
    point1?: PointEntity
    point2?: PointEntity
  }) => string[]
}

/**
 * Single entity rules: specific measurements (first match wins).
 *
 * **Order Matters:** Rules are ordered by property specificity. More restrictive checks first.
 * - Circle: requires center + radius, explicitly forbids angle_start (distinguishes from arc)
 * - Arc: requires center + radius + angle_start (more specific than line)
 * - Line: requires start + end, forbids radius (distinguishes from arc)
 * - Point: catches everything else; returns no measurement (vertices unmeasurable alone)
 */
export const SINGLE_ENTITY_RULES: readonly SingleEntityRule[] = [
  // Circle: diameter measurement
  {
    label: 'Circle diameter',
    evaluate: (entity) => {
      const e = entity as unknown as Record<string, unknown>
      if (!('center' in e && 'radius' in e && !('angle_start' in e))) return []
      const circle = entity as Circle
      const d = (circle.radius || 0) * 2
      return [`[CIRCLE] d=${d.toFixed(2)} mm`]
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
      const sweepDeg = Math.abs(sweep) * 180 / Math.PI
      return [`[ARC] r=${r.toFixed(2)} mm, θ=${sweepDeg.toFixed(0)}°`]
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
 * Multi-entity rules: pair-based measurements (first match wins).
 *
 * **Order Matters:** Rules are ordered by measurement priority, not by specificity.
 * - Point-to-line: basic geometric constraint (e.g., perpendicular distance)
 * - Line-line: angle or parallel distance (2-DOF relationship)
 * - Arc/circle pairs: center distances (simpler than angle)
 * - Point-to-arc/circle: center distance (simpler than other relationships)
 * - Point-point: only measured if far enough apart (distance > 0.01mm avoids numerical noise)
 *
 * All rules check for required properties and return empty [] if no match.
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
  // Arc + circle center distance
  {
    label: 'Arc/circle center distance',
    evaluate: (entities) => {
      const arc = entities.arc as Arc | undefined
      const circle = entities.circle as Circle | undefined
      if (!arc || !circle) return []
      const dist = Math.hypot(circle.center[0] - arc.center[0], circle.center[1] - arc.center[1])
      return [`center dist: ${dist.toFixed(2)} mm`]
    },
  },
  // Circle-circle center distance
  {
    label: 'Circle center distance',
    evaluate: (entities) => {
      const circle1 = entities.circle1 as Circle | undefined
      const circle2 = entities.circle2 as Circle | undefined
      if (!circle1 || !circle2) return []
      const dist = Math.hypot(circle2.center[0] - circle1.center[0], circle2.center[1] - circle1.center[1])
      return [`center dist: ${dist.toFixed(2)} mm`]
    },
  },
  // Point to arc center distance
  {
    label: 'Point/arc center distance',
    evaluate: (entities) => {
      const point = entities.point as PointEntity | undefined
      const arc = entities.arc as Arc | undefined
      if (!point || !arc) return []
      const dist = Math.hypot(arc.center[0] - point.x, arc.center[1] - point.y)
      return [`center dist: ${dist.toFixed(2)} mm`]
    },
  },
  // Point to circle center distance
  {
    label: 'Point/circle center distance',
    evaluate: (entities) => {
      const point = entities.point as PointEntity | undefined
      const circle = entities.circle as Circle | undefined
      if (!point || !circle) return []
      const dist = Math.hypot(circle.center[0] - point.x, circle.center[1] - point.y)
      return [`center dist: ${dist.toFixed(2)} mm`]
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
    circle1?: Circle
    circle2?: Circle
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

export interface Plane3D {
  origin: [number, number, number]
  normal: [number, number, number]
  x_axis: [number, number, number]
  y_axis: [number, number, number]
}

/**
 * Measure distance between point and plane: perpendicular distance from point to plane.
 */
export function measurePointToPlane(point: PointEntity, plane: Plane3D): string[] {
  // Convert 2D point to 3D (assume z=0 in sketch plane)
  const p = [point.x, point.y, 0]
  const n = plane.normal
  const o = plane.origin

  // Distance = |dot(p - o, normal)|
  const toPlane = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
  const dist = Math.abs(toPlane[0] * n[0] + toPlane[1] * n[1] + toPlane[2] * n[2])

  return [`plane distance: ${dist.toFixed(2)} mm`]
}

// Resolve a selection ID to a body + element kind + index by reverse-lookup in bodies.
function findBodyElement(
  id: string,
  bodies: Record<string, BodyResult>
): { body: BodyResult; kind: 'edge' | 'face' | 'vertex'; index: number } | null {
  // Simple slash format: @featureId/edge/N, @featureId/face/N, or @featureId/vertex/N
  if (id.startsWith('@') && id.includes('/')) {
    const slash1 = id.indexOf('/', 1)
    const slash2 = id.indexOf('/', slash1 + 1)
    if (slash1 > 0 && slash2 > 0) {
      const featureId = id.slice(1, slash1)
      const kind = id.slice(slash1 + 1, slash2) as 'edge' | 'face' | 'vertex'
      const index = parseInt(id.slice(slash2 + 1), 10)
      const body = bodies[featureId]
      if (body && (kind === 'edge' || kind === 'face' || kind === 'vertex') && !isNaN(index)) {
        return { body, kind, index }
      }
    }
  }
  // Ancestry / query format: search all bodies for a matching query string
  for (const body of Object.values(bodies)) {
    if (body.edge_queries) {
      const idx = body.edge_queries.indexOf(id)
      if (idx >= 0) return { body, kind: 'edge', index: idx }
    }
    if (body.mesh?.face_queries) {
      const idx = body.mesh.face_queries.indexOf(id)
      if (idx >= 0) return { body, kind: 'face', index: idx }
    }
    if (body.vertex_queries) {
      const idx = body.vertex_queries.indexOf(id)
      if (idx >= 0) return { body, kind: 'vertex', index: idx }
    }
  }
  return null
}

/**
 * Measure a single or pair of 3D body elements.
 * - 1 edge: length (line) or radius+sweep (arc/circle)
 * - 1 face: area
 * - 2 line edges: angle or parallel distance
 * - 2 arc/circle edges: center-to-center distance
 * Returns [] when no rule matches or data is unavailable.
 */
export function measure3dSelection(
  ids: Set<string>,
  bodies: Record<string, BodyResult>
): string[] {
  if (ids.size === 1) {
    const id = [...ids][0]
    const found = findBodyElement(id, bodies)
    if (!found) return []
    const { body, kind, index } = found

    if (kind === 'edge') {
      const edge = body.edges?.[index]
      if (!edge) return []
      if (edge.kind === 'line') {
        const [ax, ay, az] = edge.start
        const [bx, by, bz] = edge.end
        const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
        return [`[EDGE] ${len.toFixed(2)} mm`]
      }
      if (edge.kind === 'arc' || edge.kind === 'circle') {
        const arcEdge = edge as EdgeDataCircleArc
        const sweep = Math.abs(arcEdge.angle_end - arcEdge.angle_start)
        const deg = (sweep * 180 / Math.PI).toFixed(1)
        return [`[EDGE] r=${arcEdge.radius.toFixed(2)} mm, \u03b8=${deg}\u00b0`]
      }
      return []
    }

    if (kind === 'face') {
      const faceData = body.mesh?.face_data?.[index]
      if (faceData?.area != null) {
        return [`[FACE] area=${faceData.area.toFixed(2)} mm\u00b2`]
      }
      return []
    }

    return []
  }

  if (ids.size === 2) {
    const [idA, idB] = [...ids]
    const foundA = findBodyElement(idA, bodies)
    const foundB = findBodyElement(idB, bodies)
    if (!foundA || !foundB) return []

    // ─── Face + Face: parallel plane distance ───
    if (foundA.kind === 'face' && foundB.kind === 'face') {
      const fA = foundA.body.mesh?.face_data?.[foundA.index]
      const fB = foundB.body.mesh?.face_data?.[foundB.index]
      if (!fA || !fB) return []
      const dot = Math.abs(fA.normal[0] * fB.normal[0] + fA.normal[1] * fB.normal[1] + fA.normal[2] * fB.normal[2])
      if (Math.abs(dot - 1) > 1e-6) return []
      const dx = fB.centroid[0] - fA.centroid[0], dy = fB.centroid[1] - fA.centroid[1], dz = fB.centroid[2] - fA.centroid[2]
      const dist = Math.abs(dx * fA.normal[0] + dy * fA.normal[1] + dz * fA.normal[2])
      return [`plane distance: ${dist.toFixed(2)} mm`]
    }

    // ─── Face + Vertex: perpendicular distance ───
    if ((foundA.kind === 'face' && foundB.kind === 'vertex') || (foundA.kind === 'vertex' && foundB.kind === 'face')) {
      const faceFound = foundA.kind === 'face' ? foundA : foundB
      const vertFound = foundA.kind === 'vertex' ? foundA : foundB
      const fd = faceFound.body.mesh?.face_data?.[faceFound.index]
      const v = vertFound.body.vertices?.[vertFound.index]
      if (!fd || !v) return []
      const dx = v[0] - fd.centroid[0], dy = v[1] - fd.centroid[1], dz = v[2] - fd.centroid[2]
      const dist = Math.abs(dx * fd.normal[0] + dy * fd.normal[1] + dz * fd.normal[2])
      return [`plane distance: ${dist.toFixed(2)} mm`]
    }

    // ─── Face + Edge: perpendicular distance from edge midpoint ───
    if ((foundA.kind === 'face' && foundB.kind === 'edge') || (foundA.kind === 'edge' && foundB.kind === 'face')) {
      const faceFound = foundA.kind === 'face' ? foundA : foundB
      const edgeFound = foundA.kind === 'edge' ? foundA : foundB
      const fd = faceFound.body.mesh?.face_data?.[faceFound.index]
      const edge = edgeFound.body.edges?.[edgeFound.index]
      if (!fd || !edge || edge.kind !== 'line') return []
      const mx = (edge.start[0] + edge.end[0]) / 2
      const my = (edge.start[1] + edge.end[1]) / 2
      const mz = (edge.start[2] + edge.end[2]) / 2
      const dx = mx - fd.centroid[0], dy = my - fd.centroid[1], dz = mz - fd.centroid[2]
      const dist = Math.abs(dx * fd.normal[0] + dy * fd.normal[1] + dz * fd.normal[2])
      return [`plane distance: ${dist.toFixed(2)} mm`]
    }

    // ─── Face + anything else: no match ───
    if (foundA.kind === 'face' || foundB.kind === 'face') return []

    // ─── Vertex + anything else: no match ───
    if (foundA.kind === 'vertex' || foundB.kind === 'vertex') return []

    if (foundA.kind !== 'edge' || foundB.kind !== 'edge') return []

    const edgeA = foundA.body.edges?.[foundA.index]
    const edgeB = foundB.body.edges?.[foundB.index]
    if (!edgeA || !edgeB) return []

    if (edgeA.kind === 'line' && edgeB.kind === 'line') {
      const [ax0, ay0, az0] = edgeA.start
      const [ax1, ay1, az1] = edgeA.end
      const [bx0, by0, bz0] = edgeB.start
      const [bx1, by1, bz1] = edgeB.end
      const dax = ax1 - ax0, day = ay1 - ay0, daz = az1 - az0
      const dbx = bx1 - bx0, dby = by1 - by0, dbz = bz1 - bz0
      const lenA = Math.sqrt(dax * dax + day * day + daz * daz)
      const lenB = Math.sqrt(dbx * dbx + dby * dby + dbz * dbz)
      if (lenA < 1e-10 || lenB < 1e-10) return []
      const dot = Math.abs(dax * dbx + day * dby + daz * dbz) / (lenA * lenB)
      const clampedDot = Math.max(0, Math.min(1, dot))
      const angle = Math.acos(clampedDot)
      if (angle < 1e-4) {
        // Parallel: compute perpendicular distance between the infinite lines
        const [cx, cy, cz] = [bx0 - ax0, by0 - ay0, bz0 - az0]
        const crossX = cy * daz - cz * day, crossY = cz * dax - cx * daz, crossZ = cx * day - cy * dax
        const dist = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ) / lenA
        return [`parallel edges, distance: ${dist.toFixed(2)} mm`]
      }
      return [`edge angle: ${(angle * 180 / Math.PI).toFixed(1)}\u00b0`]
    }

    if ((edgeA.kind === 'arc' || edgeA.kind === 'circle') && (edgeB.kind === 'arc' || edgeB.kind === 'circle')) {
      const a = edgeA as EdgeDataCircleArc
      const b = edgeB as EdgeDataCircleArc
      const [cx, cy, cz] = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]]
      const dist = Math.sqrt(cx * cx + cy * cy + cz * cz)
      return [`center dist: ${dist.toFixed(2)} mm`]
    }

    return []
  }

  return []
}

/**
 * Measure distance/angle between two planes.
 * Parallel planes: distance between them.
 * Non-parallel planes: no measurement (would need angle, but spec says none).
 */
export function measurePlanes(plane1: Plane3D, plane2: Plane3D): string[] {
  const n1 = plane1.normal
  const n2 = plane2.normal

  // Check if planes are parallel: normals point in same/opposite directions
  const dot = Math.abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2])
  const parallel = Math.abs(dot - 1.0) < 1e-6

  if (!parallel) {
    // Non-parallel planes: spec says no measurement
    return []
  }

  // Parallel planes: compute distance between origins projected onto normal
  const o1 = plane1.origin
  const o2 = plane2.origin
  const toPlane = [o2[0] - o1[0], o2[1] - o1[1], o2[2] - o1[2]]
  const dist = Math.abs(toPlane[0] * n1[0] + toPlane[1] * n1[1] + toPlane[2] * n1[2])

  return [`plane distance: ${dist.toFixed(2)} mm`]
}
