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
  applyAddConstraint(
    probeDoc, pending.featureId, pending.kind, pending.targets, pending.value, pending.pos, pending.sign,
  )
  const probeFeature = (probeDoc.features ?? []).find((f) => f.id === pending.featureId) as SketchFeature | undefined
  const draft = probeFeature?.constraints?.at(-1)
  const before = feature.constraints?.length ?? 0
  // The mutation layer can drop an unresolvable pick without appending
  // anything; there is nothing to probe, and the doc would no-op too.
  if (!probeFeature || !draft || (probeFeature.constraints?.length ?? 0) === before) return null
  return { probeFeature, draft }
}

/**
 * True when adding the pending constraint to `doc` would add no new rank.
 * Anything that cannot be decided (no doc, a non-sketch feature, no solver, a
 * constraint the mutation layer drops, an unsatisfied draft set) answers false:
 * the add proceeds and the next solve reports whatever it finds.
 */
export function wouldOverconstrain(doc: PartDoc | null, pending: PendingConstraintAdd): boolean {
  const drafted = draftPendingConstraint(doc, pending)
  if (!drafted) return false
  return probeRedundantConstraint(drafted.probeFeature, drafted.draft.id) === true
}
