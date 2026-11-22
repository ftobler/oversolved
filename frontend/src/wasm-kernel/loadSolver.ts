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
 *
 * Both loaders install the profile-loop facade as they hand the module over.
 * The facade is synchronous and has no injection point of its own on the plain
 * node path (`setSketchSolver(bytes)` carries solve bytes only), so a host that
 * booted the package but forgot the facade would fail every area build with
 * "profile loops: Rust core not initialised". Installing at the one place the
 * package is read keeps that from depending on each host remembering.
 */

import { loadPkgNodeExport, loadPkgNodeModuleFresh } from './loadPkgNode'
import { setProfileLoopsBytes } from './profileLoops'
import type { ProfileLoopsBytes, SketchSolverBundle, SolveBytes } from './wasmTypes'

/** Adopt the facade from one module evaluation. A build without the export
 *  clears it, which is the loud "run `just wasm`" error rather than a stale
 *  function pointed at an older heap. */
function adoptProfileLoops(loops: ProfileLoopsBytes | null): void {
  setProfileLoopsBytes(typeof loops === 'function' ? loops : null)
}

export function loadSolver(): SolveBytes | null {
  const solve = loadPkgNodeExport<SolveBytes>('solve_sketch_bytes')
  if (typeof solve !== 'function') return null
  // The node package is required once and cached, so this second named read is
  // the same wasm instance, not a second instantiation.
  adoptProfileLoops(loadPkgNodeExport<ProfileLoopsBytes>('profile_loops_bytes'))
  return solve
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
  const solve = mod.solve_sketch_bytes
  if (typeof solve !== 'function') return null
  const topology = mod.detect_topology_bytes
  const profileLoops = mod.profile_loops_bytes
  adoptProfileLoops(typeof profileLoops === 'function' ? profileLoops : null)
  return {
    solve,
    topology: typeof topology === 'function' ? topology : null,
    profileLoops: typeof profileLoops === 'function' ? profileLoops : null,
  }
}
