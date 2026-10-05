// Lazy-load the Rust mate solver WASM entry point (`solve_mate_bytes`).
// This is its own binary (the `mate-solver` crate), so the anchor solver worker
// compiles ~116 KB of mate code and nothing of the sketch solver or topology
// builder. `solverWasm.ts` caches per package per global, so the OCC worker and
// the anchor solver worker each get their own instance anyway (separate worker
// processes) -- the split is about what each one has to fetch and compile.

import { loadMateWasm, loadMateWasmLive } from './solverWasm'
import type { SolveBytes } from './wasmTypes'

let mateSolver: SolveBytes | null = null
let mateSolverLive: SolveBytes | null = null

/** Load the mate solver WASM once. Safe to call multiple times, subsequent
 *  calls are no-ops when already loaded. Returns a Promise that resolves when
 *  loading completes (or fails). Both entry points share one module load. */
export function initAnchorSolver(base?: string): Promise<void> {
  return Promise.all([loadMateWasm(base), loadMateWasmLive(base)]).then(([full, live]) => {
    mateSolver = full
    mateSolverLive = live
  })
}

/** The Rust `solve_mate_bytes` function, or null if not yet loaded. */
export function getMateSolver(): SolveBytes | null {
  return mateSolver
}

/** The Rust `solve_mate_bytes_live` function, or null when the loaded build
 *  predates it. The worker falls back to `getMateSolver` for a null. */
export function getMateSolverLive(): SolveBytes | null {
  return mateSolverLive
}
