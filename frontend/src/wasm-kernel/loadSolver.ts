/**
 * Load the Rust sketch solver for headless (Node/vitest) use.
 *
 * Thin wrapper over `loadPkgNodeExport`: resolves `solve_sketch_bytes` from the
 * wasm-pack `--target nodejs` package, returning null when that gitignored build
 * artifact is absent so the shadow harness skips instead of breaking
 * `just frontend` on a fresh checkout.
 *
 * The browser app instead loads the live `--target web` build through
 * `solverWasm.ts`, on the main thread (`initSketchSolver` in
 * `kernel/features/sketch.ts`). This loader is for parity testing only.
 */

import { loadPkgNodeExport } from './loadPkgNode'
import type { SolveBytes } from './wasmTypes'

export function loadSolver(): SolveBytes | null {
  return loadPkgNodeExport<SolveBytes>('solve_sketch_bytes')
}
