// Lazy-load the Rust mate solver WASM entry point (`solve_mate_bytes`).
// The same WASM binary also contains the sketch solver and topology functions;
// the shared `loadWebModule` in `solverWasm.ts` keeps a single module cache
// per global, so the OCC worker and the anchor solver worker each get their
// own instance (separate worker processes).

import { loadMateWasm } from './solverWasm'
import type { SolveBytes } from './codec'

let mateSolver: SolveBytes | null = null

/** Load the mate solver WASM once. Safe to call multiple times — subsequent
 *  calls are no-ops when already loaded. Returns a Promise that resolves when
 *  loading completes (or fails). */
export function initAnchorSolver(base?: string): Promise<void> {
  return loadMateWasm(base).then((f) => { mateSolver = f })
}

/** The Rust `solve_mate_bytes` function, or null if not yet loaded. */
export function getMateSolver(): SolveBytes | null {
  return mateSolver
}
