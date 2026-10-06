// Small pure helpers the sketch editor store leans on: hover tuple equality,
// the dev/test invariant gate, claim pruning, and tool normalization. None of
// these own state; they are here so the store module reads as actions.
import type { ActiveTool } from '@/types/cad'
import { validateSketchEditorState, repairSelectionState } from './stateInvariants'
import type { SketchEditorState } from './sketchEditorTypes'

/** Coordinate-wise equality for the small tuples the hover setters carry, so a
 *  freshly built tuple holding the same numbers counts as "unchanged". */
export function samePoint(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Dev/test-only harness gate (user decision 2026-08-05, Option B). repair then
// validate, so a healable violation never failLouds on the very state repair
// just produced. Callers gate on `devOnly || testMode`; there is deliberately
// no store subscription that runs this on every mutation, so production carries
// a violating write silently until a later gate or a test catches it.
export function validateWithRepair(get: () => SketchEditorState, set: (p: Partial<SketchEditorState>) => void): void {
  const state = get()
  const patches = repairSelectionState(state)
  if (patches) {
    set(patches)
    const repaired = get()
    validateSketchEditorState(repaired)
  } else {
    validateSketchEditorState(state)
  }
}

// A pickKey claim only means anything while its query is still selected. Chip
// diffs evict queries wholesale, so the claims they leave behind must go with
// them or they resurrect as ghost highlights the next time the query is picked.
// Returns the original map when nothing was pruned so subscribers stay put.
export function prunePickClaims(picks: Map<string, Set<string>>, live: ReadonlySet<string>): Map<string, Set<string>> {
  let pruned: Map<string, Set<string>> | null = null
  for (const q of picks.keys()) {
    if (live.has(q)) continue
    if (pruned === null) pruned = new Map(picks)
    pruned.delete(q)
  }
  return pruned ?? picks
}

export const getEffectiveTool = (activeTool: ActiveTool): NonNullable<ActiveTool> => activeTool ?? 'drag'
