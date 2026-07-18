/**
 * Resolve a named export from a wasm-pack `--target nodejs` package for
 * headless (Node/vitest) use. That target loads its wasm synchronously via
 * `fs.readFileSync`, so no async init is needed.
 *
 * There are two packages, one per solver crate (see `solverWasm.ts` for why
 * they are split), so the caller names which one it wants. Both are gitignored
 * build artifacts: run `just wasm` first. When the package is absent this
 * returns null so parity harnesses skip instead of breaking `just frontend` on
 * a fresh checkout.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** The wasm-pack packages, by crate directory and JS entry stem. */
export const PKG_SKETCH = { dir: 'sketch-solver', stem: 'sketch_solver' } as const
export const PKG_MATE = { dir: 'mate-solver', stem: 'mate_solver' } as const

export type PkgNodeTarget = typeof PKG_SKETCH | typeof PKG_MATE

export function loadPkgNodeExport<T>(name: string, pkg: PkgNodeTarget = PKG_SKETCH): T | null {
  try {
    const require = createRequire(import.meta.url)
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, `../../../${pkg.dir}/pkg-node/${pkg.stem}.js`)
    const mod = require(pkgPath) as Record<string, unknown>
    return mod[name] as T
  } catch {
    return null
  }
}
