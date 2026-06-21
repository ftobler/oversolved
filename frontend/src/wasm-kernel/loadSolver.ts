/**
 * Load the Rust sketch solver for headless (Node/vitest) use.
 *
 * Thin wrapper over `loadPkgNodeExport`: resolves `solve_sketch_bytes` from the
 * wasm-pack `--target nodejs` package, returning null when that gitignored build
 * artifact is absent so the shadow harness skips instead of breaking
 * `just frontend` on a fresh checkout.
 *
 * The browser app will instead load the `--target web` build inside the builder
 * Worker; that wiring is a later shard. This loader is for parity testing only.
 */

import { loadPkgNodeExport } from './loadPkgNode'

export type SolveBytes = (input: Uint8Array) => Uint8Array

export function loadSolver(): SolveBytes | null {
  return loadPkgNodeExport<SolveBytes>('solve_sketch_bytes')
}
