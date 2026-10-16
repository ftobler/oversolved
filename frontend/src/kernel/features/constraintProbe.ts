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
import type { PartDoc, SketchFeature } from '@/types/cad'
import { applyAddConstraint } from '@/utils/yamlMutations/sketch'
import { probeRedundantConstraint } from './sketch'

export interface PendingConstraintAdd {
  featureId: string
  kind: string
  targets: string[]
  value?: number
  pos?: [number, number]
  sign?: number
}

/**
 * True when adding the pending constraint to `doc` would add no new rank.
 * Anything that cannot be decided (no doc, a non-sketch feature, no solver, a
 * constraint the mutation layer drops, an unsatisfied draft set) answers false:
 * the add proceeds and the next solve reports whatever it finds.
 */
export function wouldOverconstrain(doc: PartDoc | null, pending: PendingConstraintAdd): boolean {
  if (!doc) return false
  const feature = (doc.features ?? []).find((f) => f.id === pending.featureId)
  if (feature?.kind !== 'sketch') return false

  // Deep-clone just the touched feature: `applyAddConstraint` may materialize
  // inferred points into the entity list as well as append the constraint.
  const probeDoc: PartDoc = {
    ...doc,
    features: (doc.features ?? []).map((f) => (f.id === pending.featureId ? structuredClone(f) : f)),
  }
  applyAddConstraint(
    probeDoc, pending.featureId, pending.kind, pending.targets, pending.value, pending.pos, pending.sign,
  )
  const probeFeature = (probeDoc.features ?? []).find((f) => f.id === pending.featureId) as SketchFeature | undefined
  const draft = probeFeature?.constraints?.at(-1)
  const before = feature.constraints?.length ?? 0
  // The mutation layer can drop an unresolvable pick without appending
  // anything; there is nothing to probe, and the doc would no-op too.
  if (!probeFeature || !draft || (probeFeature.constraints?.length ?? 0) === before) return false
  return probeRedundantConstraint(probeFeature, draft.id) === true
}
