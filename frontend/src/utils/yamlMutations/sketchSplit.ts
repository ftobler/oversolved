// The split_entity applier: cut one sketch curve at one or more points into
// entities meeting there. The shape does not change, only the entity
// boundaries do. The cut math and the constraint carry live in the shared
// piece-rewrite engine (utils/geometry/sketchPieces); this file owns the pick
// validation, the refusal sentences and the document write.
//
// Every point is validated before the first write, and the drive value rule
// calls the same plan, so an external step is refused for exactly the reason
// the applier would use. A refused split leaves the document byte-identical.

import type { PartDoc, Point, SketchFeature } from '@/types/cad'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { entityPointXY } from '@/registry/entityRegistry'
import {
  PIECE_PICK_TOL,
  isPieceEntityKind,
  planPieceRewrite,
  pointOnEntity,
  type PieceRef,
  type PieceRewritePlan,
  type RefField,
} from '@/utils/geometry/sketchPieces'
import { MutationRefusal, findSketchFeature, localEntityRef, mintEntityId, resolveSketch, warn } from './helpers'
import { applyAddConstraint, applyDeleteElements } from './sketch'

type SplitFeatureInput = Pick<SketchFeature, 'id' | 'entities' | 'initial' | 'constraints'>

/** Why a kind cannot be split, by name. Shared with the tool's hover so the
 *  click never fails silently. */
export function splitKindProblem(kind: string): string | null {
  if (kind === 'ellipse') return 'an ellipse cannot be split: there is no elliptical-arc entity kind to cut it into'
  if (kind === 'fit_spline') {
    return 'a fit spline cannot be split: a piece of it is not the interpolant of its own fit points'
  }
  if (kind === 'point') return 'a point has no length to split'
  if (!isPieceEntityKind(kind)) return `a ${kind} cannot be split`
  return null
}

const fmt = (v: number) => String(Number(v.toPrecision(6)))

/**
 * Validate a split and plan it. `at` holds sketch-plane points; each is
 * projected onto the entity and must lie within the pick tolerance of it,
 * inside its span, away from an open curve's ends and away from every other
 * point. A circle needs two points: one cut cannot open a closed curve.
 */
export function planSplitEntity(
  feature: SplitFeatureInput,
  entityId: string,
  at: readonly Point[],
): PieceRewritePlan {
  const entity = (feature.entities ?? []).find(e => e.id === entityId)
  if (entity === undefined) {
    return { code: 'unknown-target', reason: `entity "${entityId}" names no entity in sketch "${feature.id}"` }
  }
  const kindProblem = splitKindProblem(entity.kind)
  if (kindProblem !== null) return { code: 'invalid', reason: kindProblem }
  if (at.length === 0) return { code: 'invalid', reason: 'at must name at least one point' }
  if (entity.kind === 'circle' && at.length < 2) {
    return { code: 'invalid', reason: 'a circle needs two split points: one cut cannot open a closed curve' }
  }
  const params = feature.initial?.[entityId] ?? []
  const ends = entity.kind === 'circle'
    ? []
    : (['start', 'end'] as const).map(key => entityPointXY(entity.kind, params, key)).filter(p => p !== undefined)
  const cuts: number[] = []
  const feet: Point[] = []
  for (let index = 0; index < at.length; index++) {
    const point = at[index]
    const where = `point ${index} (${fmt(point[0])}, ${fmt(point[1])})`
    const foot = pointOnEntity(entity.kind, params, point)
    if (foot === null) return { code: 'invalid', reason: `"${entityId}" has no usable geometry to split` }
    if (foot.distance > PIECE_PICK_TOL) {
      return {
        code: 'invalid',
        reason: `${where} lies ${fmt(foot.distance)} from "${entityId}", beyond the pick tolerance ${PIECE_PICK_TOL}`,
      }
    }
    if (!foot.inSpan) return { code: 'invalid', reason: `${where} lies past the end of "${entityId}"` }
    if (ends.some(end => Math.hypot(end[0] - foot.foot[0], end[1] - foot.foot[1]) <= TOL_TOPOLOGY_MERGE)) {
      return { code: 'invalid', reason: `${where} lies on an end of "${entityId}"; there is nothing to split there` }
    }
    const merged = feet.findIndex(other => Math.hypot(other[0] - foot.foot[0], other[1] - foot.foot[1]) <= TOL_TOPOLOGY_MERGE)
    if (merged >= 0) return { code: 'invalid', reason: `${where} is the same point as point ${merged}` }
    feet.push(foot.foot)
    cuts.push(foot.param)
  }
  const pieceCount = entity.kind === 'circle' ? cuts.length : cuts.length + 1
  return planPieceRewrite(feature, entityId, cuts, Array.from({ length: pieceCount }, () => true))
}

/**
 * Write a piece-rewrite plan: the id-keeping piece takes over the entity, every
 * other kept piece is minted right after it, then the constraint removals,
 * in-place rewrites and the authored ties. Shared with trim, which plans the
 * same shape with a dropped piece.
 */
export function applyPieceRewrite(doc: PartDoc, featureId: string, plan: Exclude<PieceRewritePlan, { reason: string }>, label: string): void {
  const writable = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (writable === undefined) return
  const index = writable.entities.findIndex(e => e.id === plan.entityId)
  if (index < 0) return
  const original = writable.entities[index]
  const construction = original.construction === true

  const ids: Array<string | null> = plan.pieces.map(() => null)
  let insertAt = index + 1
  plan.pieces.forEach((piece, i) => {
    if (!piece.kept) return
    if (piece.keepsId) {
      ids[i] = original.id
      if (original.kind !== piece.kind) original.kind = piece.kind
      writable.initial[original.id] = [...piece.params]
      return
    }
    const id = mintEntityId(writable.entities)
    ids[i] = id
    writable.entities.splice(insertAt++, 0, construction ? { id, kind: piece.kind, construction: true } : { id, kind: piece.kind })
    writable.initial[id] = [...piece.params]
  })

  const idOf = (ref: PieceRef): string => {
    const id = ids[ref.piece]
    if (id === null) throw new Error(`${label}: the plan names dropped piece ${ref.piece}`)
    return id
  }
  const localRef = (ref: PieceRef) => localEntityRef(idOf(ref), ref.vertex)
  const targetRef = (ref: PieceRef | string) => {
    if (typeof ref === 'string') return ref
    return ref.vertex === undefined
      ? `entity:${featureId}:${idOf(ref)}`
      : `vertex:${featureId}:${idOf(ref)}:${ref.vertex}`
  }

  if (plan.removeConstraintIds.length > 0) {
    applyDeleteElements(doc, plan.removeConstraintIds.map(id => `constraint:${featureId}:${id}`))
  }
  for (const rewrite of plan.rewrites) {
    const constraint = writable.constraints.find(c => c.id === rewrite.constraintId)
    if (constraint === undefined) continue
    if (rewrite.kind !== undefined) constraint.kind = rewrite.kind
    for (const field of rewrite.clear ?? []) delete constraint[field]
    for (const field of Object.keys(rewrite.set) as RefField[]) {
      const ref = rewrite.set[field]
      if (ref !== undefined) constraint[field] = localRef(ref)
    }
  }
  for (const add of plan.addConstraints) {
    const outcome = applyAddConstraint(doc, featureId, add.kind, add.targets.map(targetRef), add.value, undefined, add.sign)
    // The plan only authors rows the pieces satisfy by construction; a refusal
    // here would leave half a rewrite, so the whole step is refused instead
    // (the session discards its working copy on a refusal).
    if (outcome !== 'added') {
      throw new MutationRefusal(`${label}: the ${add.kind} tie between the pieces was ${outcome}; the step was not applied`)
    }
  }
}

/** split_entity: one mutation, one undo entry, whatever the point count. */
export function applySplitEntity(doc: PartDoc, featureId: string, entityId: string, at: readonly Point[]): void {
  const feature = findSketchFeature(doc, featureId)
  if (feature === undefined) {
    warn('split_entity: feature id names no sketch', { featureId })
    return
  }
  const plan = planSplitEntity(feature, entityId, at)
  if ('reason' in plan) {
    warn('split_entity: refused, document left untouched', { featureId, entityId, reason: plan.reason })
    return
  }
  applyPieceRewrite(doc, featureId, plan, 'split_entity')
}
