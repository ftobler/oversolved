// Freezing a projection is the deliberate, link-free version of a projected
// entity: one mutation removes the projection and pins the geometry it held, so
// a later source edit, delete or reorder cannot move it. The editor freezes the
// last published solve (what the user sees); the drive flushes first and records
// a face projection's member rows in the mutation, so a replay never solves.
//
// The solver's `fixed` pins every param of a whole-entity target: a line's two
// ends, a circle's centre and radius, an arc's centre/radius/angles, and every
// spline control or fit point. One row is therefore the minimal non-redundant
// set for every kind a projection can hold; a per-kind table would only add
// rows that read overconstrained.
import type {
  Mutation,
  PartConstraint,
  PartDoc,
  PartFeature,
  ProjectionMemberEntityData,
  ProjectionMemberReportData,
  SketchFeature,
} from '@/types/cad'
import { findSketchFeature, MutationRefusal, uniqueConstraintId } from './helpers'
import { constraintDisplayName, entityDisplayName, featureDisplayName } from '@/utils/core/displayNames'
import { applyDeleteElements } from './sketch'
import {
  freezeRowsForDelete,
  isProjectionPosition,
  projectionsFreezingNothing,
} from '@/kernel/features/projectionMembers'

export type FreezeProjectionMode = 'fixed' | 'free'

/** The stored wire ref of a single-entity projection. Kept here, the host-local
 *  `$` emitter, so the drive checks and the applier spell the target once. */
export function projectionTargetRef(entityId: string): string {
  return `$${entityId}`
}

/** The `fixed` rows a frozen entity needs. The whole-entity target is the one
 *  non-redundant spelling the solver reads for every kind, so `kind` is carried
 *  only to keep the caller's entity shape; it does not change the set. */
export function fixedConstraintsFor(
  entity: { id: string; kind: string },
  existing: readonly PartConstraint[] = [],
): PartConstraint[] {
  return [{
    id: uniqueConstraintId([...existing], 'fixed'),
    kind: 'fixed',
    target: projectionTargetRef(entity.id),
  }]
}

/** A face projection is the target with no `target` ref; its members are the
 *  derived rows the solve reported. */
function isFaceProjection(constraint: PartConstraint): boolean {
  return constraint.kind === 'projection' && constraint.target === undefined
}

interface ResolvedProjection {
  constraint: PartConstraint
  // The held entity id for a single-entity projection; null for a face.
  entityId: string | null
}

/** Resolve a freeze target to the projection it names. A constraint id wins,
 *  because a face projection has no other spelling; a held entity id and a face
 *  member id both resolve through the constraint rows. */
function resolveProjectionTarget(
  feature: SketchFeature,
  target: string,
  features: readonly PartFeature[],
): ResolvedProjection {
  const constraints = feature.constraints ?? []
  const byId = constraints.find(c => c.id === target && c.kind === 'projection')
  if (byId !== undefined) {
    return { constraint: byId, entityId: heldEntityId(byId) }
  }
  const byEntity = constraints.find(c => c.kind === 'projection' && c.target === projectionTargetRef(target))
  if (byEntity !== undefined) {
    return { constraint: byEntity, entityId: target }
  }
  const byMember = constraints.find(c =>
    isFaceProjection(c) && Object.values(c.members ?? {}).includes(target))
  if (byMember !== undefined) {
    return { constraint: byMember, entityId: null }
  }
  throw new MutationRefusal(
    `freeze_projection: that pick names no projection in ${featureDisplayName(feature, features)}; `
    + 'pass a projected entity, a projection constraint, or one of its members',
  )
}

function heldEntityId(constraint: PartConstraint): string | null {
  if (typeof constraint.target !== 'string') return null
  return constraint.target.startsWith('$') ? constraint.target.slice(1) : constraint.target
}

/** The one-sentence refusal when a projected entity has no baked position: the
 *  stored/hand-edited "left out of the profile" state, where there is no
 *  geometry to fix. The remedy is deleting the projection, which the text names
 *  because the user cannot see the difference from a resolved one. */
function projectionPositionProblem(
  feature: SketchFeature,
  constraint: PartConstraint,
  features: readonly PartFeature[],
): string | null {
  const name = constraintDisplayName(feature, constraint.id) ?? 'the projection'
  const entityId = heldEntityId(constraint)
  if (entityId === null) {
    return `${name} holds no entity; delete the projection instead`
  }
  const entity = (feature.entities ?? []).find(candidate => candidate.id === entityId)
  const entityName = entityDisplayName(feature, entityId) ?? 'the picked entity'
  if (entity === undefined) {
    return `${name} holds ${entityName}, which is not an entity of ${featureDisplayName(feature, features)}; `
      + 'delete the projection instead'
  }
  if (!isProjectionPosition(feature.initial?.[entityId], entity.kind, entity.handles)) {
    return `${name} holds ${entityName}, which has no position to freeze; `
      + 'delete the projection instead'
  }
  return null
}

/** The member rows a face freeze may write: only ids the constraint still owns
 *  and that are not excluded, the same filter the delete path applies. */
function faceFreezeRows(
  constraint: PartConstraint,
  materialize: readonly ProjectionMemberEntityData[] | undefined,
): ProjectionMemberEntityData[] {
  if (materialize === undefined || materialize.length === 0) return []
  const members = constraint.members ?? {}
  const live = new Set(Object.values(members))
  const excluded = new Set(constraint.excluded ?? [])
  const tokenById = new Map(Object.entries(members).map(([token, id]) => [id, token]))
  const rows: ProjectionMemberEntityData[] = []
  for (const row of materialize) {
    if (!live.has(row.id)) continue
    const token = tokenById.get(row.id)
    if (token !== undefined && excluded.has(token)) continue
    if (!rows.some(candidate => candidate.id === row.id)) rows.push(row)
  }
  return rows
}

function pushFixed(feature: SketchFeature, entityId: string): void {
  if (!feature.constraints) feature.constraints = []
  const kind = (feature.entities ?? []).find(entity => entity.id === entityId)?.kind ?? ''
  for (const row of fixedConstraintsFor({ id: entityId, kind }, feature.constraints)) {
    feature.constraints.push(row)
  }
}

/**
 * Apply one `freeze_projection`. A face projection reuses the delete path with
 * its recorded member rows, exactly as a materialize delete does, then pins each
 * written row; a single-entity projection removes the constraint and pins the
 * held entity. Every refusal throws before any row is written, so a rejected
 * step leaves the document byte-identical.
 */
export function applyFreezeProjection(
  doc: PartDoc,
  featureId: string,
  target: string,
  mode: FreezeProjectionMode = 'fixed',
  materialize?: readonly ProjectionMemberEntityData[],
): void {
  const feature = findSketchFeature(doc, featureId)
  // A stale feature id is a no-op, the same contract every sketch applier keeps.
  if (feature === undefined) return
  const features = doc.features ?? []
  const resolved = resolveProjectionTarget(feature, target, features)
  const constraint = resolved.constraint

  if (isFaceProjection(constraint)) {
    const rows = faceFreezeRows(constraint, materialize)
    if (rows.length === 0) {
      throw new MutationRefusal(
        `freeze_projection: ${constraintDisplayName(feature, constraint.id) ?? 'the projection'} in `
        + `${featureDisplayName(feature, features)} has no solved member rows to freeze; `
        + 'rebuild the source, or delete the projection',
      )
    }
    // The delete path writes the rows under their derived ids and removes the
    // constraint, so constraints already attached to a member keep working.
    applyDeleteElements(doc, [`constraint:${featureId}:${constraint.id}`], rows)
    if (mode === 'fixed') {
      const next = findSketchFeature(doc, featureId)
      if (next !== undefined) for (const row of rows) pushFixed(next, row.id)
    }
    return
  }

  const problem = projectionPositionProblem(feature, constraint, features)
  if (problem !== null) throw new MutationRefusal(`freeze_projection: ${problem}`)
  const entityId = resolved.entityId ?? heldEntityId(constraint)
  applyDeleteElements(doc, [`constraint:${featureId}:${constraint.id}`])
  if (mode === 'fixed' && entityId !== null) {
    const next = findSketchFeature(doc, featureId)
    if (next !== undefined) pushFixed(next, entityId)
  }
}

/** The sketch selection ids that name a projection: a projected entity, a face
 *  projection's member (mapped to its owning tile), or a projection constraint
 *  tile. Plain geometry, vertices and other constraints are ignored, which is
 *  what makes a mixed selection freeze only what it can. */
export function projectedSelectionTargets(
  feature: SketchFeature | undefined,
  selection: ReadonlySet<string>,
): string[] {
  if (feature === undefined || feature.kind !== 'sketch') return []
  const featureId = feature.id
  const constraints = feature.constraints ?? []
  const faceByMember = new Map<string, string>()
  for (const constraint of constraints) {
    if (!isFaceProjection(constraint)) continue
    for (const memberId of Object.values(constraint.members ?? {})) {
      if (!faceByMember.has(memberId)) faceByMember.set(memberId, constraint.id)
    }
  }
  const out: string[] = []
  const push = (id: string) => { if (!out.includes(id)) out.push(id) }
  for (const target of selection) {
    const parts = target.split(':')
    if (parts.length < 3 || parts[1] !== featureId) continue
    if (parts[0] === 'entity') {
      const entityId = parts[2]
      if (constraints.some(c => c.kind === 'projection' && c.target === projectionTargetRef(entityId))) {
        push(`entity:${featureId}:${entityId}`)
        continue
      }
      const owner = faceByMember.get(entityId)
      if (owner !== undefined) push(`constraint:${featureId}:${owner}`)
      continue
    }
    if (parts[0] !== 'constraint') continue
    const constraintId = parts[2]
    if (constraints.some(c => c.id === constraintId && c.kind === 'projection')) {
      push(`constraint:${featureId}:${constraintId}`)
    }
  }
  return out
}

/** What one freeze command should dispatch and what it cannot freeze. One
 *  mutation per projection, so the caller can send them as one undo batch;
 *  `notFrozen` names face projections with no solved rows and `refused` carries
 *  a sentence for each never-positioned entity. */
export interface FreezeSelectionPlan {
  mutations: Mutation[]
  notFrozen: string[]
  refused: string[]
}

export function freezeSelectionPlan(
  feature: SketchFeature,
  selection: ReadonlySet<string>,
  mode: FreezeProjectionMode,
  reports: Readonly<Record<string, ProjectionMemberReportData>> | null | undefined,
  features: readonly PartFeature[] = [],
): FreezeSelectionPlan {
  const plan: FreezeSelectionPlan = { mutations: [], notFrozen: [], refused: [] }
  for (const selectionId of projectedSelectionTargets(feature, selection)) {
    const parts = selectionId.split(':')
    const target = parts[2]
    let resolved: ResolvedProjection
    try {
      resolved = resolveProjectionTarget(feature, target, features)
    } catch (e) {
      // The resolver already established this name a projection; a refusal here
      // would be a race the plan pre-check is meant to prevent.
      if (!(e instanceof MutationRefusal)) throw e
      continue
    }
    const constraint = resolved.constraint
    if (isFaceProjection(constraint)) {
      const tile = `constraint:${feature.id}:${constraint.id}`
      const rows = freezeRowsForDelete(feature.id, feature, [tile], reports)
      if (rows === undefined) {
        const empty = projectionsFreezingNothing(feature.id, feature, [tile], reports)
        const id = empty[0] ?? constraint.id
        if (!plan.notFrozen.includes(id)) plan.notFrozen.push(id)
        continue
      }
      plan.mutations.push({
        type: 'freeze_projection', featureId: feature.id, target: constraint.id, mode, materialize: rows,
      })
      continue
    }
    const problem = projectionPositionProblem(feature, constraint, features)
    if (problem !== null) {
      plan.refused.push(problem)
      continue
    }
    const entityId = resolved.entityId ?? heldEntityId(constraint)
    if (entityId === null) continue
    plan.mutations.push({ type: 'freeze_projection', featureId: feature.id, target: entityId, mode })
  }
  return plan
}
