// The fillet_corners applier: round one or more corners of a sketch profile by
// trimming both straight sides to their tangent points and joining them with one
// authored arc per corner. The math lives in utils/geometry/filletCorner; this
// file owns the document write and the constraint policy.
//
// Every corner is validated before the first write. A step with one bad corner
// applies nothing: there is no per-corner partial apply, and the drive boundary
// is expected to have refused the same step before it reached here.
//
// Constraint policy:
// - the coincident joint(s) between the two trimmed endpoints are deleted;
// - a tangent between the two sides, a second coincident on either trimmed
//   endpoint, or a fixed/dimension that anchors either trimmed endpoint is
//   refused by constraint id, because moving the endpoint would silently change
//   what it meant;
// - every other constraint is left alone.

import type { PartConstraint, PartDoc, SketchFeature } from '@/types/cad'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { lineVertexIndices } from '@/utils/geometry/offsetProfile'
import {
  planFilletGeometry,
  type FilletCorner,
  type FilletCornerSide,
  type FilletGeometry,
} from '@/utils/geometry/filletCorner'
import {
  CONSTRAINT_REF_FIELDS,
  findSketchFeature,
  isVertexKeyRef,
  mintEntityId,
  refMatchesEntity,
  resolveSketch,
  warn,
} from './helpers'
import { applyAddConstraint, applyDeleteElements } from './sketch'

export interface PlannedFilletCorner extends FilletGeometry {
  // Constraint ids to delete before the trims are written.
  removeConstraintIds: string[]
}

export type FilletSketchPlan =
  | { corners: PlannedFilletCorner[] }
  | { code: 'invalid' | 'unknown-target'; reason: string }

type FilletSketchInput = Pick<SketchFeature, 'entities' | 'initial' | 'constraints'>

function constraintRefs(c: PartConstraint): string[] {
  const refs: string[] = []
  for (const field of CONSTRAINT_REF_FIELDS) {
    const value = c[field]
    if (typeof value === 'string') refs.push(value)
  }
  if (Array.isArray(c.refs)) refs.push(...c.refs)
  if (typeof c.circle === 'string') refs.push(c.circle)
  return refs
}

function touchesEntity(c: PartConstraint, entityId: string): boolean {
  return constraintRefs(c).some(ref => refMatchesEntity(ref, entityId))
}

function touchesVertex(c: PartConstraint, entityId: string, vertexKey: string): boolean {
  return constraintRefs(c).some(ref => isVertexKeyRef(ref, entityId, vertexKey))
}

function isJoint(c: PartConstraint, corner: FilletCorner): boolean {
  if (c.kind !== 'coincident' || typeof c.a !== 'string' || typeof c.b !== 'string') return false
  const forward = isVertexKeyRef(c.a, corner.a, corner.aVertex)
    && isVertexKeyRef(c.b, corner.b, corner.bVertex)
  const backward = isVertexKeyRef(c.a, corner.b, corner.bVertex)
    && isVertexKeyRef(c.b, corner.a, corner.aVertex)
  return forward || backward
}

/**
 * Validate the whole step and return the geometry plus the constraints to
 * delete. Shared by the applier and the drive value rule so an external step is
 * refused for exactly the reason the document write would use.
 */
export function planFilletCorners(
  feature: FilletSketchInput,
  radius: number,
  corners: readonly FilletCorner[],
): FilletSketchPlan {
  const entities = feature.entities ?? []
  const initial = feature.initial ?? {}
  const constraints = feature.constraints ?? []
  const byId = new Map(entities.map(entity => [entity.id, entity]))

  for (let index = 0; index < corners.length; index++) {
    for (const [id, key] of [[corners[index].a, 'a'], [corners[index].b, 'b']] as const) {
      if (!byId.has(id)) {
        return {
          code: 'unknown-target',
          reason: `corner ${index}: side "${id}" (${key}) names no entity in the sketch`,
        }
      }
    }
  }

  const heldByProjection = new Set(
    (feature.constraints ?? [])
      .filter(c => c.kind === 'projection' && typeof c.target === 'string')
      .map(c => String(c.target).replace(/^\$/, '')),
  )
  const sides: FilletCornerSide[] = entities.map(entity => ({
    id: entity.id,
    kind: entity.kind,
    params: initial[entity.id] ?? [],
    construction: entity.construction === true,
    heldByProjection: heldByProjection.has(entity.id),
  }))
  const geometry = planFilletGeometry(sides, corners, radius)
  if ('reason' in geometry) {
    return { code: geometry.missingId === undefined ? 'invalid' : 'unknown-target', reason: geometry.reason }
  }

  const planned: PlannedFilletCorner[] = []
  for (let index = 0; index < geometry.corners.length; index++) {
    const corner = corners[index]
    const geo = geometry.corners[index]
    const where = `corner ${index}`

    const joints = constraints.filter(c => isJoint(c, corner))
    const jointIds = new Set(joints.map(c => c.id))

    // A tangent between the two sides says the corner does not exist: the
    // "corner" is already a smooth blend.
    const tangent = constraints.find(c =>
      c.kind === 'tangent' && touchesEntity(c, corner.a) && touchesEntity(c, corner.b))
    if (tangent !== undefined) {
      return {
        code: 'invalid',
        reason: `${where}: sides "${corner.a}" and "${corner.b}" already meet tangentially `
          + `(constraint "${tangent.id}"); there is no corner to fillet`,
      }
    }

    for (const side of [
      { id: corner.a, key: corner.aVertex },
      { id: corner.b, key: corner.bVertex },
    ]) {
      const secondJoint = constraints.find(c =>
        c.kind === 'coincident' && !jointIds.has(c.id) && touchesVertex(c, side.id, side.key))
      if (secondJoint !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: the trimmed endpoint "${side.id}:${side.key}" carries a second coincident `
            + `(constraint "${secondJoint.id}"); a T-junction or duplicate joint is ambiguous`,
        }
      }

      const fixed = constraints.find(c =>
        c.kind === 'fixed'
        && (touchesEntity(c, side.id) || touchesVertex(c, side.id, side.key)))
      if (fixed !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: constraint "${fixed.id}" is a fixed on the trimmed endpoint `
            + `"${side.id}:${side.key}"; remove or re-anchor it first`,
        }
      }

      const dimension = constraints.find(c =>
        c.value !== undefined && touchesVertex(c, side.id, side.key))
      if (dimension !== undefined) {
        return {
          code: 'invalid',
          reason: `${where}: constraint "${dimension.id}" dimensions the trimmed endpoint `
            + `"${side.id}:${side.key}"; remove or re-anchor it first`,
        }
      }
    }

    planned.push({ ...geo, removeConstraintIds: [...jointIds] })
  }

  return { corners: planned }
}

function trimEndpoint(params: number[], vertexKey: 'start' | 'end', to: readonly [number, number]): void {
  const indices = lineVertexIndices(vertexKey)
  if (indices === null) return
  const [ix, iy] = indices
  // An endpoint already at the tangent point is left byte-identical: rounding it
  // again would rewrite the same number for no reason.
  if (Math.hypot(params[ix] - to[0], params[iy] - to[1]) <= TOL_TOPOLOGY_MERGE) return
  params[ix] = to[0]
  params[iy] = to[1]
}

/**
 * fillet_corners: trim each named side to its tangent point and join the pair
 * with a tangent arc. One mutation is one undo entry, whatever the corner count.
 */
export function applyFilletCorners(
  doc: PartDoc,
  featureId: string,
  radius: number,
  corners: readonly FilletCorner[],
): void {
  const feature = findSketchFeature(doc, featureId)
  if (feature === undefined) {
    warn('fillet_corners: feature id names no sketch', { featureId })
    return
  }
  const plan = planFilletCorners(feature, radius, corners)
  if ('reason' in plan) {
    warn('fillet_corners: refused, document left untouched', { featureId, reason: plan.reason })
    return
  }

  const writable = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (writable === undefined) return

  const removeIds = plan.corners.flatMap(corner => corner.removeConstraintIds)
  if (removeIds.length > 0) {
    applyDeleteElements(doc, removeIds.map(id => `constraint:${featureId}:${id}`))
  }

  for (const corner of plan.corners) {
    const paramsA = writable.initial[corner.a]
    const paramsB = writable.initial[corner.b]
    if (paramsA === undefined || paramsB === undefined) continue
    trimEndpoint(paramsA, corner.aVertex, corner.ta)
    trimEndpoint(paramsB, corner.bVertex, corner.tb)

    const arcId = mintEntityId(writable.entities)
    writable.entities.push(corner.construction
      ? { id: arcId, kind: 'arc', construction: true }
      : { id: arcId, kind: 'arc' })
    writable.initial[arcId] = [...corner.arc]

    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${corner.a}:${corner.aVertex}`,
      `vertex:${featureId}:${arcId}:${corner.arcStart}`,
    ])
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${arcId}:${corner.arcEnd}`,
      `vertex:${featureId}:${corner.b}:${corner.bVertex}`,
    ])
    applyAddConstraint(doc, featureId, 'tangent', [
      `entity:${featureId}:${corner.a}`,
      `entity:${featureId}:${arcId}`,
    ])
    applyAddConstraint(doc, featureId, 'tangent', [
      `entity:${featureId}:${arcId}`,
      `entity:${featureId}:${corner.b}`,
    ])
  }
}
