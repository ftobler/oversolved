/**
 * Load the Rust sketch solver from the wasm-pack `--target nodejs` package.
 *
 * Thin wrapper over `loadPkgNodeExport`: resolves `solve_sketch_bytes`,
 * returning null when that gitignored build artifact is absent so the shadow
 * harness skips instead of breaking `just frontend` on a fresh checkout.
 *
 * The browser app instead loads the live `--target web` build through
 * `solverWasm.ts`, on the main thread (`initSketchSolver` in
 * `kernel/features/sketch.ts`). Everything outside the browser uses the
 * pkg-node build: the headless vitest suites and the drive/MCP kernel worker
 * (`drive/kernelWorker.ts`) boot it, and they install `loadSolverFresh` as a
 * loader so a trap can be recovered with a new module instance.
 */

import { loadPkgNodeExport, loadPkgNodeModuleFresh } from './loadPkgNode'
import type { SketchSolverBundle, SolveBytes, TopologyBytes } from './wasmTypes'

export function loadSolver(): SolveBytes | null {
  return loadPkgNodeExport<SolveBytes>('solve_sketch_bytes')
}

/**
 * Load the sketch solver and area builder from a NEW module instance.
 *
 * This is the loader a headless host installs for trap recovery
 * (`setSketchSolverLoader`), not the boot-time injection: after a WASM trap the
 * heap is undefined, so the replacement has to be a new instance, and the
 * package's Node-cached module cannot provide one. Both exports come from the
 * one fresh evaluation, so the area builder still shares the solver's heap.
 */
export function loadSolverFresh(): SketchSolverBundle | null {
  const mod = loadPkgNodeModuleFresh()
  if (mod === null) return null
  const solve = mod.solve_sketch_bytes as SolveBytes | undefined
  if (typeof solve !== 'function') return null
  const topology = mod.detect_topology_bytes as TopologyBytes | undefined
  return { solve, topology: typeof topology === 'function' ? topology : null }
}
