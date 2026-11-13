/**
 * The authoring gate for a new constraint: would it make the constraint set
 * redundant? The editor state store asks through a port before creating the
 * `add_constraint` mutation, so a refused add leaves the document untouched
 * (and undo untouched). Redundant constraints that are already IN a document
 * (loaded docs, auto-deduction, chained edits) are not errors: the solve
 * reports them and the UI marks them as non-drivers.
 *
 * The probe builds the exact mutation the document would take on a COPY of the
 * feature, then asks the real solver through `probeRedundantConstraint`. The
 * copy is what makes the doc side effect free; the real solver is what makes
 * the answer correct for implied redundancy (a parallel already implied by two
 * horizontals), which no static duplicate check could see.
 */
import type { PartConstraint, PartDoc, SketchFeature } from '@/types/cad'
import { applyAddConstraint, applyAddProjectedEntity } from '@/utils/yamlMutations/sketch'
import type { ProjectionMemberEntity } from './projectionMembers'
import { probeRedundantConstraint } from './sketch'

/** One `add_projected_entity` the pending add depends on. The constraint
 *  command plans the projection before the probe runs, so the probe applies it
 *  to its draft copy; otherwise the target names an entity the draft lacks and
 *  the add drops as unresolved. */
export interface ProjectionPrelude {
  type: 'add_projected_entity'
  featureId: string
  kind: string
  source: string
  entityId?: string
  constraintId?: string
}

export interface PendingConstraintAdd {
  featureId: string
  kind: string
  targets: string[]
  value?: number
  pos?: [number, number]
  sign?: number
  prelude?: readonly ProjectionPrelude[]
}

/** The probe's draft: a copy of the touched feature with the planned
 *  projections and the pending constraint applied, or null when the add would
 *  no-op. Exported so the prelude contract is testable without a solve. */
export function draftPendingConstraint(
  doc: PartDoc | null,
  pending: PendingConstraintAdd,
): { probeFeature: SketchFeature; draft: PartConstraint } | null {
  if (!doc) return null
  const feature = (doc.features ?? []).find((f) => f.id === pending.featureId)
  if (feature?.kind !== 'sketch') return null

  // Deep-clone just the touched feature: `applyAddConstraint` may materialize
  // inferred points into the entity list as well as append the constraint.
  const probeDoc: PartDoc = {
    ...doc,
    features: (doc.features ?? []).map((f) => (f.id === pending.featureId ? structuredClone(f) : f)),
  }
  // The planned projections are not in the document yet: apply them to the
  // draft first, so a target that names one resolves and the probe answers
  // about the constraint rather than dropping it as unresolved.
  for (const m of pending.prelude ?? []) {
    applyAddProjectedEntity(probeDoc, m.featureId, m.kind, m.source, m.entityId, m.constraintId)
  }
  const probeFeature = (probeDoc.features ?? []).find((f) => f.id === pending.featureId) as SketchFeature | undefined
  if (!probeFeature) return null
  // Count AFTER the prelude: the projections already grew the list, so
  // comparing against the original feature would read the projection as a
  // drafted constraint and hide a dropped add (one-target coincident, an
  // unresolvable dock/isect target, an unrecognised midpoint form).
  const before = probeFeature.constraints?.length ?? 0
  applyAddConstraint(
    probeDoc, pending.featureId, pending.kind, pending.targets, pending.value, pending.pos, pending.sign,
  )
  const after = probeFeature.constraints?.length ?? 0
  if (after <= before) return null
  const draft = probeFeature.constraints?.at(-1)
  if (!draft) return null
  return { probeFeature, draft }
}

/** What the authoring gate should do with a pending add. */
export type PendingConstraintVerdict = 'ok' | 'redundant' | 'dropped'

/**
 * Classify a pending constraint add before any mutation is created. `dropped`
 * means the mutation layer would append nothing (the add is malformed for the
 * operand set), so the caller must emit nothing rather than its planned
 * projections.
 */
export function classifyPendingAdd(
  doc: PartDoc | null,
  pending: PendingConstraintAdd,
  resolvedKinds?: Readonly<Record<string, string>>,
  derivedMembers?: readonly ProjectionMemberEntity[],
): PendingConstraintVerdict {
  if (!doc) return 'ok'
  const feature = (doc.features ?? []).find((f) => f.id === pending.featureId)
  if (feature?.kind !== 'sketch') return 'ok'
  const drafted = draftPendingConstraint(doc, pending)
  if (!drafted) return 'dropped'
  return probeRedundantConstraint(drafted.probeFeature, drafted.draft.id, resolvedKinds, derivedMembers) === true ? 'redundant' : 'ok'
}

/**
 * True when adding the pending constraint to `doc` would add no new rank.
 * Anything that cannot be decided (no doc, a non-sketch feature, no solver, an
 * unsatisfied draft set) answers false: the add proceeds and the next solve
 * reports whatever it finds.
 */
export function wouldOverconstrain(doc: PartDoc | null, pending: PendingConstraintAdd): boolean {
  return classifyPendingAdd(doc, pending) === 'redundant'
}
