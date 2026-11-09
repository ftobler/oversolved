// The doc-writing half of the solver write-back, extracted pure so a headless
// host (the node CLI) bakes solved geometry into each feature's `initial` and
// reconciles `part_style` from the body set, close to what the browser adapter
// does in useSolver.applySolveResult. This is the one doc write outside the
// mutation path; it is derived from the authored spec, not user intent, so it
// records no undo entry and the journal ignores it (it is not a command).
//
// It is not identical to the browser adapter: this write-back prunes
// `part_style` entries for bodies the solve consumed, while the browser
// reconciles additively. The difference and its user-side cost are recorded on
// the backlog's `part_style` decision.

import type { PartDoc, BodyResult } from '@/types/cad'
import { applyGeometryToFeature, shouldBakeSketchGeometry } from '@/utils/yamlMutations/solveResult'
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

/** What one write-back left behind. `movedFeatureIds` names the sketches whose
 *  geometry was installed (a fresh map rounded to the document grid); they are
 *  the sketches a settle pass must solve again, and the ones a non-settling cap
 *  names in the reply's note. */
export interface SolveWriteBack {
  doc: PartDoc
  geometryMoved: boolean
  movedFeatureIds: string[]
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

export function applySolveToDoc(doc: PartDoc, response: SolveResponseLike): SolveWriteBack {
  const cloned: PartDoc = structuredClone(doc)
  const movedFeatureIds: string[] = []
  for (const [id, feature] of Object.entries(response.result ?? {})) {
    const row = feature as {
      geometry?: Record<string, number[]>
      entity_moved?: string[]
      status?: string
    } | null
    const geometry = row?.geometry
    if (geometry && shouldBakeSketchGeometry(row)) {
      // The solver names what it moved; an absent report means every entity
      // takes the exact no-op test instead of the reference keep.
      const moved = Array.isArray(row.entity_moved) ? new Set(row.entity_moved) : undefined
      if (applyGeometryToFeature(cloned, id, geometry, moved)) {
        movedFeatureIds.push(id)
      }
    }
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
  return {
    doc: cloned,
    geometryMoved: movedFeatureIds.length > 0,
    movedFeatureIds,
  }
}
