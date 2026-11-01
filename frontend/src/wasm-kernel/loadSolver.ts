/**
 * Load the Rust sketch solver from the wasm-pack `--target nodejs` package.
 *
 * Thin wrapper over `loadPkgNodeExport`: resolves `solve_sketch_bytes`,
 * returning null when that gitignored build artifact is absent so the shadow
 * harness skips instead of breaking `just frontend` on a fresh checkout.
 *
 * The browser app instead loads the live `--target web` build through
 * `solverWasm.ts`, on the main thread (`initSketchSolver` in
 * `kernel/features/sketch.ts`). Everything outside the browser uses this one:
 * the headless vitest suites and the drive/MCP kernel worker
 * (`drive/kernelWorker.ts`) both boot it.
 */

import { loadPkgNodeExport } from './loadPkgNode'
import type { SolveBytes } from './wasmTypes'

export function loadSolver(): SolveBytes | null {
  return loadPkgNodeExport<SolveBytes>('solve_sketch_bytes')
}
