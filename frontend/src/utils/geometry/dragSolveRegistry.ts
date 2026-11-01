// PURE LOGIC -- no Three.js, no React. Module-level carrier for the last
// successful WASM drag-frame solve, bridging the rAF loop (useWasmDragSolve)
// and the pointer-up commit (DragTool). Not Zustand state on purpose: nothing
// should re-render on it, it is written every drag frame and read exactly
// once at pointer-up. Same pattern as getSketchCallback in sketchEditorStore.
import type { CircleDragMode } from '@/kernel/features/circleDragMode'

export interface LastDragSolve {
  featureId: string
  /** Per-entity solved params of the last drag frame; committed into
   *  `feature.initial` on pointer-up so the hard solve seeds from the
   *  on-screen state instead of pre-drag geometry + a teleported vertex.
   *  Optional only for a `locked` drag, which publishes a mode-only entry
   *  (no solve runs, so there is no geometry to carry). */
  geometry?: Record<string, number[]>
  /** Resolved at drag activation: 'translate' (default/absent), 'radius', or
   *  'locked'. Read once at pointer-up so the commit can choose the mutation
   *  without re-probing the solver. */
  mode?: CircleDragMode
}

let last: LastDragSolve | null = null

export function setLastDragSolve(v: LastDragSolve | null): void {
  last = v
}

/** Clear the slot only when the stored entry belongs to `featureId`. The
 *  registry is one global slot shared by every sketch, so an unscoped clear in
 *  a foreign sketch's effect cleanup would wipe a live drag's published frames
 *  and make pointer-up commit fall back to pre-drag seeding. */
export function clearLastDragSolveFor(featureId: string): void {
  if (last?.featureId !== featureId) return
  last = null
}

export function getLastDragSolve(): LastDragSolve | null {
  return last
}
