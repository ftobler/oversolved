/**
 * Load the Rust pure-geometry family (`profile_loops_bytes`) for headless
 * (Node/vitest) use. Twin of `loadTopology.ts`: a thin wrapper over
 * `loadPkgNodeExport`, resolving the export from the same `--target nodejs`
 * package and returning null when that gitignored build artifact is absent so
 * a suite can skip instead of breaking on a fresh checkout.
 */

import { loadPkgNodeExport } from './loadPkgNode'
import type { ProfileLoopsBytes } from './wasmTypes'

export function loadProfileLoops(): ProfileLoopsBytes | null {
  return loadPkgNodeExport<ProfileLoopsBytes>('profile_loops_bytes')
}
