// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Entity } from '../../types/cad'
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

/** Collect vertex candidates from a single sketch.
 *  skipEntityId: entity to exclude (pass '' to exclude nothing -- used for other sketches). */
function collectFromSketch(sketch: Sketch, featureId: string, skipEntityId: string): VertexCandidate[] {
  const targets: VertexCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if (entityId === skipEntityId) continue

    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:start`, position: l.start, snapKind: 'vertex' })
      targets.push({ vertexId: `vertex:${featureId}:${entityId}:end`,   position: l.end,   snapKind: 'vertex' })
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

/** Collect all discrete vertex positions from the active sketch and any additional visible
 *  sketches. Projected entities in the active sketch are now included -- they represent
 *  real spatial positions (origin, projected edges) and are valid snap targets.
 *  skipEntityId excludes the dragged entity from the active sketch only. */
export function collectVertexTargets(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): VertexCandidate[] {
  const targets = collectFromSketch(sketch, featureId, skipEntityId)
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      targets.push(...collectFromSketch(otherSketch, otherFeatId, ''))
    }
  }
  return targets
}

/** Find the best snap target using the same snap registry as the drawing tools.
 *  Searches the active sketch and any additional visible sketches.
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
  otherSketches?: Record<string, Sketch>,
): SnapTarget | null {
  // First pass: find nearest vertex within its (larger) pull zone across all sketches.
  let bestVertex: (VertexCandidate & { dist: number }) | null = null
  let bestVertexDist = vertexThreshold
  for (const t of collectVertexTargets(sketch, featureId, skipEntityId, otherSketches)) {
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
  const pathConstraintKind = suggestConstraint(draggedType, 'path')
  if (pathConstraintKind === null) return null  // registry disallows path snap for this dragged type

  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold

  const scanBodies = (bodySketch: Sketch, bodyFeatId: string, bodySkipId: string) => {
    for (const [entityId, entity] of Object.entries(bodySketch)) {
      if (entityId === bodySkipId) continue
      const result = nearestPointOnEntity(x, y, entity as Entity)
      if (result && result.distance < bestEntityDist) {
        bestEntityDist = result.distance
        bestEntity = {
          kind: 'entity',
          position: result.position as [number, number],
          constraintKind: pathConstraintKind,
          entityRef: `entity:${bodyFeatId}:${entityId}`,
        }
      }
    }
  }

  scanBodies(sketch, featureId, skipEntityId)
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      scanBodies(otherSketch, otherFeatId, '')
    }
  }

  return bestEntity
}
