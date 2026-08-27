// PURE LOGIC -- no Three.js, no React. Module-level carrier for the last
// successful WASM drag-frame solve, bridging the rAF loop (useWasmDragSolve)
// and the pointer-up commit (DragTool). Not Zustand state on purpose: nothing
// should re-render on it, it is written every drag frame and read exactly
// once at pointer-up. Same pattern as getSketchCallback in sketchEditorStore.
import type { CircleDragMode } from '@/components/Geometry3D/circleDragMode'

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

export function getLastDragSolve(): LastDragSolve | null {
  return last
}
