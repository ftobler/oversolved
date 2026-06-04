/**
 * Browser/Worker loader for opencascade.js, mirroring `solverWasm.ts`.
 *
 * The OCC module is a heavy, opt-in, gitignored artifact served at a
 * configurable base URL (default `/occ/`); it is NOT bundled. The dynamic
 * import is `@vite-ignore`d so `vite build` never tries to resolve it. When it
 * is absent this resolves to `null` and the caller degrades gracefully rather
 * than breaking.
 *
 * Provisioning the served artifact (copying `opencascade.wasm.js` +
 * `opencascade.wasm.wasm` under `public/occ/` and pointing the JS at the wasm)
 * is a later shard; this loader pins the seam. The headless node loader
 * (`loadOcc.ts`) is what the spike tests actually exercise today.
 */

import type { OccModule } from './occTypes'

type OccFactory = (config: {
  locateFile: (path: string) => string
}) => Promise<OccModule>

const DEFAULT_BASE = '/occ/'

let cached: Promise<OccModule | null> | null = null

export function loadOccWeb(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  if (cached) return cached
  cached = (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ `${base}opencascade.wasm.js`)) as {
        default: OccFactory
      }
      return await mod.default({
        locateFile: (path) => (path.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : path),
      })
    } catch {
      return null
    }
  })()
  return cached
}

/** Reset the memoized module (tests / hot-reload). */
export function resetOccWeb(): void {
  cached = null
}
