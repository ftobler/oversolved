/**
 * Resolve a named export from the wasm-pack `--target nodejs` package
 * (`sketch-solver/pkg-node`) for headless (Node/vitest) use. That target loads
 * its wasm synchronously via `fs.readFileSync`, so no async init is needed.
 *
 * The package is a gitignored build artifact: run
 *   wasm-pack build --target nodejs --out-dir pkg-node --release
 * in `sketch-solver/` first. When it is absent this returns null so parity
 * harnesses skip instead of breaking `just frontend` on a fresh checkout.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function loadPkgNodeExport<T>(name: string): T | null {
  try {
    const require = createRequire(import.meta.url)
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, '../../../sketch-solver/pkg-node/sketch_solver.js')
    const mod = require(pkgPath) as Record<string, unknown>
    return mod[name] as T
  } catch {
    return null
  }
}
