import type { Sketch, LineSegment, Circle, Arc, PointEntity, Entity } from '../../types/cad'
import { isProjectedEntity } from '../../types/cad'
import { suggestConstraint, type DraggedElementType, type SnapKind } from '../../registry'
import { nearestPointOnEntity } from './nearestPoint'

// Snap kind discriminator:
//   'vertex' — cursor is close to a specific named vertex
//   'entity' — cursor is close to an entity body but not to a vertex
// Vertex snap uses a larger pull radius and takes priority.
export type DragSnapKind = 'vertex' | 'entity'

export interface SnapTarget {
  kind: DragSnapKind
  position: [number, number]
  constraintKind: string   // from suggestConstraint — same registry as drawing snap
  vertexId?: string        // set when kind === 'vertex'; format: "vertex:featureId:entityId:key"
  entityRef?: string       // set when kind === 'entity';  format: "entity:featureId:entityId"
}

interface VertexCandidate {
  vertexId: string
  position: [number, number]
  snapKind: SnapKind  // what kind of snap target this vertex is
}

/** Collect all discrete vertex positions from a sketch with their snap kinds.
 *  Excludes projected entities and the entity currently being dragged.
 *  All point handles are treated as 'vertex' snap kind (broad categorization). */
export function collectVertexTargets(sketch: Sketch, featureId: string, skipEntityId: string): VertexCandidate[] {
  const targets: VertexCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue

    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:start`, position: l.start, snapKind: 'vertex' })
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:end`,   position: l.end,   snapKind: 'vertex' })
      // Arc center is just another vertex point
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center, snapKind: 'vertex' })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:center`, position: c.center, snapKind: 'vertex' })
    } else if ('x' in entity) {
      const p = entity as PointEntity
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:xy`, position: [p.x, p.y], snapKind: 'vertex' })
    }
  }
  return targets
}

/** Find the best snap target using the same snap registry as the drawing tools.
 *  Vertex snap uses a larger pull radius than entity snap, mirroring
 *  POINT_HIT_PIXELS > HIT_PIXELS in click detection.
 *  Returns null if the registry does not allow snapping in the current configuration. */
export function findSnapTarget(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  draggedType: DraggedElementType,  // 'vertex' or 'entity' being dragged
  x: number,
  y: number,
  vertexThreshold: number,    // world units, for vertex snap (larger)
  entityThreshold: number,    // world units, for entity body snap (smaller)
): SnapTarget | null {
  // First pass: find nearest vertex within its (larger) pull zone.
  // Only keep candidates that the snap registry allows.
  let bestVertex: (VertexCandidate & { dist: number }) | null = null
  let bestVertexDist = vertexThreshold
  for (const t of collectVertexTargets(sketch, featureId, skipEntityId)) {
    const d = Math.hypot(t.position[0] - x, t.position[1] - y)
    if (d < bestVertexDist) {
      const cKind = suggestConstraint(draggedType, t.snapKind)
      if (cKind !== null) {
        bestVertexDist = d
        bestVertex = { ...t, dist: d }
      }
    }
  }
  if (bestVertex) {
    const cKind = suggestConstraint(draggedType, bestVertex.snapKind)!
    return { kind: 'vertex', position: bestVertex.position, constraintKind: cKind, vertexId: bestVertex.vertexId }
  }

  // Second pass: find nearest point on entity body (smaller pull zone,
  // only fires when no vertex is within its larger zone).
  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (isProjectedEntity(entity as Entity)) continue
    if (entityId === skipEntityId) continue
    const cKind = suggestConstraint(draggedType, 'path')
    if (cKind === null) continue  // registry disallows path snap for this dragged type
    const result = nearestPointOnEntity(x, y, entity as Entity)
    if (result && result.distance < bestEntityDist) {
      bestEntityDist = result.distance
      bestEntity = {
        kind: 'entity',
        position: result.position as [number, number],
        constraintKind: cKind,
        entityRef: `entity:${featureId}:${entityId}`,
      }
    }
  }
  return bestEntity
}
