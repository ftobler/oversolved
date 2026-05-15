import type { Sketch, LineSegment, Arc, Circle, PointEntity, BodyResult } from '@/types/cad'
import { measureSingleEntity, measurePair, measurePointToPlane, measurePlanes, measure3dSelection, type Plane3D } from '@/registry/measurementRegistry'
import { getEntityKind } from '@/types/cad'

/**
 * Compute the best measurement for a set of selected entities.
 *
 * **Pipeline:**
 * 1. Parse selection strings (entity:*, vertex:*) and classify by type (line, arc, circle, point, plane)
 * 2. Apply single-entity rules if exactly one entity exists
 * 3. Apply plane measurements if planes are selected (vertex+plane, plane+plane)
 * 4. Apply multi-entity pair rules to find a matching measurement
 * 5. Return empty if no rule matches
 *
 * **First-Match-Wins:** Registry rules are ordered by priority. Returns the first matching rule's result.
 *
 * @param selection - Set of selection strings (e.g., "vertex:S1:L1:start", "@builtin_plane_front")
 * @param sketch - Current sketch geometry (resolved entities)
 * @param solveResults - Backend solve results containing plane data and other 3D information
 * @returns Array of measurement strings (typically 0 or 1 element)
 */
export function computeMeasurements(
  selection: Set<string>,
  sketch: Sketch,
  solveResults?: Record<string, unknown>,
  bodies?: Record<string, BodyResult>
): string[] {
  // Group selections by entity type
  const lines: LineSegment[] = []
  const arcs: Arc[] = []
  const circles: Circle[] = []
  const points: PointEntity[] = []
  const planes: Plane3D[] = []
  const body3dIds = new Set<string>()

  for (const id of selection) {
    // 3D body element: @featureId/edge/N, @featureId/face/N, or ancestry query (?...)
    if (id.startsWith('?') || (id.startsWith('@') && id.includes('/'))) {
      body3dIds.add(id)
      continue
    }

    // Parse plane selections starting with @
    if (id.startsWith('@')) {
      const featureId = id.slice(1)
      if (solveResults) {
        const featureData = solveResults[featureId] as Record<string, unknown> | undefined
        const plane = featureData?.plane as Plane3D | undefined
        if (plane) {
          planes.push(plane)
        }
      }
      continue
    }

    let entityId: string | undefined
    let vertexRef: string | undefined

    if (id.startsWith('entity:')) {
      const parts = id.split(':')
      entityId = parts[2]
    } else if (id.startsWith('vertex:')) {
      const parts = id.split(':')
      entityId = parts[2]
      vertexRef = parts[3]
    } else {
      continue
    }

    if (!entityId) continue

    const entity = sketch[entityId]
    if (!entity) continue

    // If this is a vertex selection, extract the actual point coordinates
    if (vertexRef) {
      const e = entity as unknown as Record<string, unknown>
      const coords = e[vertexRef] as [number, number] | undefined
      if (coords) {
        points.push({ x: coords[0], y: coords[1] })
        continue
      }
    }

    const kind = getEntityKind(entity)
    if (kind === 'arc') {
      arcs.push(entity as Arc)
    } else if (kind === 'line') {
      lines.push(entity as LineSegment)
    } else if (kind === 'circle') {
      circles.push(entity as Circle)
    } else if (kind === 'point') {
      points.push(entity as PointEntity)
    }
  }

  // 3D body element measurements (single edge or face)
  if (body3dIds.size > 0 && bodies) {
    const result = measure3dSelection(body3dIds, bodies)
    if (result.length > 0) return result
  }

  // Track entity counts for "no match" message
  const entityCounts = {
    line: lines.length,
    arc: arcs.length,
    circle: circles.length,
    point: points.length,
    plane: planes.length,
  }
  const hasValidEntities = Object.values(entityCounts).some(count => count > 0)

  // Single vertex: no measurement (unless there's a plane)
  if (points.length === 1 && lines.length === 0 && arcs.length === 0 && circles.length === 0 && planes.length === 0) {
    return []
  }

  // Three or more vertices only: no measurement (unless there's a plane)
  if (points.length >= 3 && lines.length === 0 && arcs.length === 0 && circles.length === 0 && planes.length === 0) {
    return []
  }

  // Use registry to evaluate single-entity measurements only if there's exactly one entity total
  const totalEntities = arcs.length + circles.length + lines.length + points.length
  if (totalEntities === 1) {
    for (const entity of arcs) {
      const result = measureSingleEntity(entity)
      if (result.length > 0) return result
    }
    for (const entity of circles) {
      const result = measureSingleEntity(entity)
      if (result.length > 0) return result
    }
    for (const entity of lines) {
      const result = measureSingleEntity(entity)
      if (result.length > 0) return result
    }
    for (const entity of points) {
      const result = measureSingleEntity(entity)
      if (result.length > 0) return result
    }
  }

  // Plane-only measurements (2+ planes)
  if (planes.length >= 2 && lines.length === 0 && arcs.length === 0 && circles.length === 0 && points.length === 0) {
    const result = measurePlanes(planes[0], planes[1])
    if (result.length > 0) return result
  }

  // Vertex + plane measurements
  if (points.length > 0 && planes.length > 0 && lines.length === 0 && arcs.length === 0 && circles.length === 0) {
    for (const point of points) {
      for (const plane of planes) {
        const result = measurePointToPlane(point, plane)
        if (result.length > 0) return result
      }
    }
  }

  // Multi-entity measurements: try all pairs
  const allEntities: Array<{ type: string; entity: LineSegment | Arc | Circle | PointEntity }> = [
    ...arcs.map(e => ({ type: 'arc', entity: e })),
    ...circles.map(e => ({ type: 'circle', entity: e })),
    ...lines.map(e => ({ type: 'line', entity: e })),
    ...points.map(e => ({ type: 'point', entity: e })),
  ]

  for (let i = 0; i < allEntities.length; i++) {
    for (let j = i + 1; j < allEntities.length; j++) {
      const e1 = allEntities[i]
      const e2 = allEntities[j]

      // Build measurement pair object
      let pair: Record<string, LineSegment | Arc | Circle | PointEntity>
      if (e1.type === e2.type) {
        // Same type: use indexed keys (type1, type2)
        pair = {
          [`${e1.type}1`]: e1.entity,
          [`${e1.type}2`]: e2.entity,
        }
      } else {
        // Different types: use type names
        pair = {
          [e1.type]: e1.entity,
          [e2.type]: e2.entity,
        }
      }

      const result = measurePair(pair)
      if (result.length > 0) return result
    }
  }

  // No match found
  if (hasValidEntities) {
    // If only planes are selected, return empty (non-parallel planes have no measurement)
    if (planes.length > 0 && lines.length === 0 && arcs.length === 0 && circles.length === 0 && points.length === 0) {
      return []
    }
    const parts: string[] = []
    if (entityCounts.line > 0) parts.push(`${entityCounts.line}x line`)
    if (entityCounts.arc > 0) parts.push(`${entityCounts.arc}x arc`)
    if (entityCounts.circle > 0) parts.push(`${entityCounts.circle}x circle`)
    if (entityCounts.point > 0) parts.push(`${entityCounts.point}x point`)
    if (entityCounts.plane > 0) parts.push(`${entityCounts.plane}x plane`)
    return [`No match for ${parts.join(', ')}`]
  }

  return []
}
