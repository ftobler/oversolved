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
  const require = createRequire(import.meta.url)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const pkgPath = path.resolve(here, `../../../${pkg.dir}/pkg-node/${pkg.stem}.js`)
  return loadExportOrNull<T>(name, pkgPath, require)
}

/** The require + classification seam, split out so the absent-vs-broken ruling
 *  can be exercised without a real wasm-pack build. `requireFn` loads `pkgPath`. */
export function loadExportOrNull<T>(
  name: string,
  pkgPath: string,
  requireFn: (path: string) => unknown,
): T | null {
  let mod: Record<string, unknown>
  try {
    mod = requireFn(pkgPath) as Record<string, unknown>
  } catch (e) {
    // Only the absent-artifact case is expected on a fresh checkout. Anything
    // else (a syntax-broken or half-built package) must surface: swallowing it
    // turns a broken build into a silent skip of the whole Rust-solver suite.
    const err = e as NodeJS.ErrnoException
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(pkgPath)) return null
    throw e
  }
  return (mod[name] as T | undefined) ?? null
}
