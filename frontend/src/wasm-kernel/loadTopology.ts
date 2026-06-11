/**
 * Load the Rust sketch area builder (`detect_topology_bytes`) for headless
 * (Node/vitest) use. Twin of `loadSolver.ts`: same `--target nodejs` package
 * (`sketch-solver/pkg-node`), synchronous wasm load, returns null when the
 * gitignored build artifact is absent so the parity harness skips instead of
 * breaking `just frontend` on a fresh checkout. Rebuild with
 *   wasm-pack build --target nodejs --out-dir pkg-node --release
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export type TopologyBytes = (input: Uint8Array) => Uint8Array

export function loadTopology(): TopologyBytes | null {
  try {
    const require = createRequire(import.meta.url)
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../../sketch-solver/pkg-node/sketch_solver.js')
    const mod = require(pkgPath) as { detect_topology_bytes: TopologyBytes }
    return mod.detect_topology_bytes
  } catch {
    return null
  }
}
