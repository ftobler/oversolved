// The doc-writing half of the solver write-back, extracted pure so a headless
// host (the node CLI) applies exactly what the browser adapter applies in
// useSolver.applySolveResult: bake solved geometry into each feature's
// `initial` and reconcile `part_style` from the body set. This is the one doc
// write outside the mutation path; it is derived from the authored spec, not
// user intent, so it records no undo entry and the journal ignores it (it is
// not a command).

import type { PartDoc, BodyResult } from '@/types/cad'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'
import { reconcilePartStyle } from '@/utils/core/partStyle'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'

// The wire-shaped solve response the write-back reads. Structural rather than
// the kernel's BuildResponse: the response crosses the worker boundary as
// structured-cloned data (useSolver casts the same way), and this module only
// needs the two slots it writes back from.
export interface SolveResponseLike {
  result?: Record<string, unknown>
  bodies?: Record<string, unknown>
}

/**
 * The solve payload a headless host builds: builtin features are display-only
 * and never reach the kernel (the browser adapter filters them too), and the
 * rollback position is the filtered feature count.
 */
export function partSolvePayload(doc: PartDoc, docId: string): Record<string, unknown> & { rollback_position: number } {
  const features = (doc.features ?? []).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
  return {
    ...doc,
    id: docId,
    features,
    rollback_position: features.length,
    is_preview: false,
  }
}

export function applySolveToDoc(doc: PartDoc, response: SolveResponseLike): PartDoc {
  const cloned: PartDoc = structuredClone(doc)
  for (const [id, feature] of Object.entries(response.result ?? {})) {
    const geometry = (feature as { geometry?: Record<string, number[]> } | null)?.geometry
    if (geometry) applyGeometryToFeature(cloned, id, geometry)
  }
  if (response.bodies) {
    // Drop colour entries for bodies this solve consumed before reconciling:
    // part_style is a style per live body, and a boolean or join leaves its
    // tool's entry behind forever otherwise. Pruning first also frees the
    // consumed part number, so a later body reuses it instead of the names
    // drifting upward. The browser adapter still reconciles additively; this
    // headless write-back is where the stale entry is removed.
    const live = new Set(Object.keys(response.bodies))
    for (const bodyId of Object.keys(cloned.part_style ?? {})) {
      if (!live.has(bodyId)) delete cloned.part_style![bodyId]
    }
    reconcilePartStyle(cloned, response.bodies as Record<string, BodyResult>)
  }
  return cloned
}
