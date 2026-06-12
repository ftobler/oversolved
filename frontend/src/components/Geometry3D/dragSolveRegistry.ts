// PURE LOGIC -- no Three.js, no React. Module-level carrier for the last
// successful WASM drag-frame solve, bridging the rAF loop (useWasmDragSolve)
// and the pointer-up commit (DragTool). Not Zustand state on purpose: nothing
// should re-render on it, it is written every drag frame and read exactly
// once at pointer-up. Same pattern as getSketchCallback in sketchEditorStore.

export interface LastDragSolve {
  featureId: string
  /** Per-entity solved params of the last drag frame; committed into
   *  `feature.initial` on pointer-up so the hard solve seeds from the
   *  on-screen state instead of pre-drag geometry + a teleported vertex. */
  geometry: Record<string, number[]>
}

let last: LastDragSolve | null = null

export function setLastDragSolve(v: LastDragSolve | null): void {
  last = v
}

export function getLastDragSolve(): LastDragSolve | null {
  return last
}
