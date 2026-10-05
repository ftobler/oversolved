/**
 * Load the Rust sketch area builder (`detect_topology_bytes`) for headless
 * (Node/vitest) use. Twin of `loadSolver.ts`: thin wrapper over
 * `loadPkgNodeExport`, resolving `detect_topology_bytes` from the same
 * `--target nodejs` package and returning null when that gitignored build
 * artifact is absent so the parity harness skips instead of breaking
 * `just frontend` on a fresh checkout.
 */

import { loadPkgNodeExport } from './loadPkgNode'
import type { TopologyBytes } from './wasmTypes'

export function loadTopology(): TopologyBytes | null {
  return loadPkgNodeExport<TopologyBytes>('detect_topology_bytes')
}
