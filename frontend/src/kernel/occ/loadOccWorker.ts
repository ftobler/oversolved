/**
 * Worker-side loader for opencascade.js. The main-thread loader
 * ([[loadOccWeb]]) injects a `<script>` tag and reads `window.opencascade`,
 * which a Web Worker cannot do (no `document`, no `window`). Inside a *module*
 * Worker we instead import the IIFE's `export default` directly off a blob URL:
 * the artifact ends with `export default opencascade;`, so a dynamic
 * `import()` of its text gives us the factory as `.default` with no DOM and no
 * export-stripping.
 *
 * The factory's `locateFile` resolves the `.wasm` to an absolute origin path;
 * the emscripten runtime `fetch`es it (available in Workers). Same heavy,
 * opt-in, gitignored artifact served under `/occ/` as the main-thread path.
 */

import type { OccModule } from './occTypes'
import { memoizedLoad } from './memoizedLoad'

const DEFAULT_BASE = '/occ/'

const occWorker = memoizedLoad(async (base: string): Promise<OccModule | null> => {
  try {
    const resp = await fetch(`${base}opencascade.wasm.js`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${base}opencascade.wasm.js`)
    const text = await resp.text()

    // The artifact is already an ES module (`export default opencascade`),
    // so import it straight off a blob URL, no DOM, no export-stripping.
    const blob = new Blob([text], { type: 'text/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    let factory: ((opts: unknown) => Promise<OccModule>) | undefined
    try {
      const mod = (await import(/* @vite-ignore */ blobUrl)) as {
        default?: (opts: unknown) => Promise<OccModule>
      }
      factory = mod.default
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    if (!factory) return null

    return await factory({
      locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
    })
  } catch (e) {
    // Non-fatal: the caller falls back to "local solver unavailable".
    console.error('[loadOccWorker] error:', e)
    return null
  }
})

export function loadOccWorker(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  return occWorker.load(base)
}
