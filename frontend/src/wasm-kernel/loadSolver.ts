/**
 * Load the Rust sketch solver for headless (Node/vitest) use.
 *
 * Uses the wasm-pack `nodejs` target (`sketch-solver/pkg-node`), which loads its
 * wasm synchronously via `fs.readFileSync`, so no async init is needed. The
 * package is a gitignored build artifact: run
 *   wasm-pack build --target nodejs --out-dir pkg-node --release
 * in `sketch-solver/` first. When it is absent this returns null so the shadow
 * harness skips instead of breaking `just frontend` on a fresh checkout.
 *
 * The browser app will instead load the `--target web` build inside the builder
 * Worker; that wiring is a later shard. This loader is for parity testing only.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export type SolveBytes = (input: Uint8Array) => Uint8Array

export function loadSolver(): SolveBytes | null {
  try {
    const require = createRequire(import.meta.url)
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../../sketch-solver/pkg-node/sketch_solver.js')
    const mod = require(pkgPath) as { solve_sketch_bytes: SolveBytes }
    return mod.solve_sketch_bytes
  } catch {
    return null
  }
}
