/**
 * Load the real OCCT 8.0.1 build (ftobler/oversolved-occt, pinned in
 * frontend/occ.pin.json) for headless (Node/vitest) use, returning an
 * [[OccModule]] or `null` when it is absent.
 *
 * The build is treated exactly like the wasm-pack solver build: a heavy,
 * gitignored, opt-in artifact, NOT a package.json dependency, so a fresh
 * checkout's `just frontend` never pulls its ~21 MB (CI's test job provisions it
 * explicitly for the Real suites). Download, verify and provision it
 * locally to run the gated Real tests:
 *
 *   just install-occ     # occ:install (download + sha256 check) and occ:provision
 *
 * Headless reads the provisioned copy in public/occ, the same verified bytes
 * the browser fetches. When it is not there this resolves to `null` and the
 * gated Real tests skip, mirroring `loadSolver.ts`.
 *
 * `occt.js` is a real ES module (MODULARIZE + EXPORT_ES6, node among its
 * environments), so it is imported as is. The wasm bytes are pre-read and
 * passed as `wasmBinary`, which short-circuits the runtime's own file lookup.
 *
 * The browser/Worker build is a separate loader; this Node loader is what the
 * headless suites, the drive/MCP kernel worker and the regen scripts use.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { OccModule } from './occTypes'
import { memoizedLoad } from './memoizedLoad'

type OccFactory = (config: { wasmBinary: Uint8Array }) => Promise<OccModule>

/** The provisioned OCCT build: frontend/public/occ. The one place headless
 *  code and the gated Real tests name it. */
export function occDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'occ')
}

/** The provisioned `occt.js`. */
export function occDistPath(): string {
  return path.join(occDistDir(), 'occt.js')
}

const occ = memoizedLoad(async (): Promise<OccModule | null> => {
  try {
    const jsPath = occDistPath()
    const factory = (await import(  /* @vite-ignore */ pathToFileURL(jsPath).href) as { default: OccFactory }).default
    const wasmBinary = readFileSync(path.join(occDistDir(), 'occt.wasm'))
    return await factory({ wasmBinary })
  } catch {
    return null
  }
})

export const loadOcc = occ.load

/** Drop the headless module so a trap recovery instantiates a fresh one. */
export function resetOcc(): void {
  occ.reset()
}

/**
 * Cheap "is OCC installed" probe: the provisioned files only, no WASM
 * instantiation. Suites whose kernel work runs in a forked child (which loads
 * its own kernel) gate on this instead of `loadOcc()` so the parent fork does
 * not hold a second ~0.5 GB heap the vitest memory model does not count.
 */
export function occInstalled(): boolean {
  return existsSync(occDistPath()) && existsSync(path.join(occDistDir(), 'occt.wasm'))
}
