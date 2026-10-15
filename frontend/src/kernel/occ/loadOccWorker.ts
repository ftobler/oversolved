/**
 * Worker-side loader for opencascade.js. The main-thread loader
 * ([[loadOccWeb]]) injects a `<script>` tag and reads `window.opencascade`,
 * which a Web Worker cannot do (no `document`, no `window`). Inside a *module*
 * Worker we instead import the IIFE's `export default` directly off a blob URL:
 * the artifact ends with `export default opencascade;`, so a dynamic
 * `import()` of its text gives us the factory as `.default` with no DOM and no
 * export-stripping.
 *
 * The wasm is compiled before the factory runs, exactly as in [[loadOccWeb]]:
 * [[compileOccWasm]] streams it with progress, and the compiled module goes to
 * the factory's `instantiateWasm` hook. Progress lands in this thread's
 * [[loadProgress]] store, which the Worker bootstrap relays to the main thread.
 */

import type { OccModule } from './occTypes'
import { memoizedLoad } from './memoizedLoad'
import { compileOccWasm, makeInstantiateWasm } from './wasmCompile'
import {
  beginOccLoad,
  reportOccCompiling,
  reportOccDownload,
  reportOccFailed,
  reportOccReady,
} from './loadProgress'

// Under the deploy base, e.g. /oversolved/ on Pages. Plain Node (the
// solve-timeout runner) has no import.meta.env, hence the optional chain.
const DEFAULT_BASE = `${import.meta.env?.BASE_URL ?? '/'}occ/`

const occWorker = memoizedLoad(async (base: string): Promise<OccModule | null> => {
  const wasmUrl = `${base}opencascade.wasm.wasm`
  beginOccLoad()
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
      const mod = (await import(  /* @vite-ignore */ blobUrl)) as {
        default?: (opts: unknown) => Promise<OccModule>
      }
      factory = mod.default
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    if (!factory) {
      reportOccFailed()
      return null
    }

    const module = await compileOccWasm(wasmUrl, {
      download: reportOccDownload,
      compiling: reportOccCompiling,
    })
    const occ = await factory({
      locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p),
      instantiateWasm: makeInstantiateWasm(module),
    })
    reportOccReady()
    return occ
  } catch (e) {
    // Non-fatal: the caller falls back to "local solver unavailable".
    console.error('[loadOccWorker] error:', e)
    reportOccFailed()
    return null
  }
})

export function loadOccWorker(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  return occWorker.load(base)
}
