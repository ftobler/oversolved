// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Entity } from '../../types/cad'
import { suggestConstraint, type DraggedElementType, type SnapKind } from '../../registry'
import { nearestPointOnEntity } from './nearestPoint'

export type DragSnapKind = 'vertex' | 'entity'

export interface SnapTarget {
  kind: DragSnapKind
  position: [number, number]
  constraintKind: string
  vertexId?: string
  entityRef?: string
}

export interface SnapCandidate {
  id: string
  position: [number, number]
  kind: SnapKind
  domain: 'active_sketch' | 'other_sketch' | 'projected' | 'body_3d'
}

export interface EntityCandidate {
  id: string
  entity: Entity
  domain: 'active_sketch' | 'other_sketch' | 'body_3d'
}

function collectFromSketch(sketch: Sketch, featureId: string, domain: SnapCandidate['domain']): SnapCandidate[] {
  const targets: SnapCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ id: `vertex:${featureId}:${entityId}:start`, position: l.start, kind: 'vertex', domain })
      targets.push({ id: `vertex:${featureId}:${entityId}:end`,   position: l.end,   kind: 'vertex', domain })
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ id: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center, kind: 'vertex', domain })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ id: `vertex:${featureId}:${entityId}:center`, position: c.center, kind: 'vertex', domain })
    } else if ('x' in entity) {
      const p = entity as PointEntity
      targets.push({ id: `vertex:${featureId}:${entityId}:xy`, position: [p.x, p.y], kind: 'vertex', domain })
    }
  }
  return targets
}

function collectEntityCandidatesFromSketch(
  sketch: Sketch,
  featureId: string,
  domain: EntityCandidate['domain'],
): EntityCandidate[] {
  return Object.entries(sketch).map(([entityId, entity]) => ({
    id: `entity:${featureId}:${entityId}`,
    entity,
    domain,
  }))
}

export function collectVertexTargets(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): SnapCandidate[] {
  const targets = collectFromSketch(sketch, featureId, 'active_sketch')
    .filter(t => !skipEntityId || !t.id.includes(`:${skipEntityId}:`))
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      targets.push(...collectFromSketch(otherSketch, otherFeatId, 'other_sketch'))
    }
  }
  return targets
}

function entityIdMatches(id: string, featureId: string, skipEntityId: string): boolean {
  return id === `entity:${featureId}:${skipEntityId}`
}

export function collectEntityCandidates(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): EntityCandidate[] {
  const targets = collectEntityCandidatesFromSketch(sketch, featureId, 'active_sketch')
    .filter(t => !skipEntityId || !entityIdMatches(t.id, featureId, skipEntityId))
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      targets.push(...collectEntityCandidatesFromSketch(otherSketch, otherFeatId, 'other_sketch'))
    }
  }
  return targets
}

export function findSnapTarget(
  candidates: SnapCandidate[],
  entityCandidates: EntityCandidate[],
  draggedType: DraggedElementType,
  x: number,
  y: number,
  vertexThreshold: number,
  entityThreshold: number,
): SnapTarget | null {
  let bestVertex: (SnapCandidate & { dist: number }) | null = null
  let bestVertexDist = vertexThreshold
  for (const t of candidates) {
    const d = Math.hypot(t.position[0] - x, t.position[1] - y)
    if (d < bestVertexDist) {
      const cKind = suggestConstraint(draggedType, t.kind)
      if (cKind !== null) {
        bestVertexDist = d
        bestVertex = { ...t, dist: d }
      }
    }
  }
  if (bestVertex) {
    const cKind = suggestConstraint(draggedType, bestVertex.kind)!
    return { kind: 'vertex', position: bestVertex.position, constraintKind: cKind, vertexId: bestVertex.id }
  }

  const pathConstraintKind = suggestConstraint(draggedType, 'path')
  if (pathConstraintKind === null) return null

  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold

  for (const ec of entityCandidates) {
    const result = nearestPointOnEntity(x, y, ec.entity)
    if (result && result.distance < bestEntityDist) {
      bestEntityDist = result.distance
      bestEntity = {
        kind: 'entity',
        position: result.position as [number, number],
        constraintKind: pathConstraintKind,
        entityRef: ec.id,
      }
    }
  }

  return bestEntity
}