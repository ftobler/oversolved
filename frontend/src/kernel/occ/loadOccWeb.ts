/**
 * Browser loader for opencascade.js via dynamic script injection.
 *
 * The Emscripten build is an IIFE that sets a global but ends with
 * ``export default opencascade;``, a syntax error in a classic ``<script>``
 * tag. We fetch the text, strip the export, create a blob URL, and inject
 * that instead. After loading, ``window.opencascade`` is the factory.
 *
 * The artifact is a heavy, opt-in, gitignored file served under ``/occ/``;
 * it is NOT bundled. Provision with:
 *
 *   npm run occ:install && npm run occ:provision
 */

import type { OccModule } from './occTypes'
import { isDevBuild } from '../isDevBuild'
import { memoizedLoad } from './memoizedLoad'

// Under the deploy base, e.g. /oversolved/ on Pages. Plain Node (the parity
// gate) has no import.meta.env, hence the optional chain.
const DEFAULT_BASE = `${import.meta.env?.BASE_URL ?? '/'}occ/`

// Memoized like the other OCC loaders. A null result (artifact absent or a
// failed load) is evicted so the next call retries, instead of pinning "local
// solver unavailable" for the whole session after one bad load.
const occWeb = memoizedLoad(async (base: string): Promise<OccModule | null> => {
  if (import.meta.env?.MODE === 'test') {
    if (isDevBuild()) console.log('[loadOccWeb] test environment, skipping')
    return null
  }
  if (isDevBuild()) console.log('[loadOccWeb] starting load from', base)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opencascade is attached to window at runtime, absent from the TS types
    const w = window as any

    if (w.opencascade) {
      if (isDevBuild()) console.log('[loadOccWeb] window.opencascade already present, calling factory')
      return await w.opencascade({
        locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
      }) as OccModule
    }

    const scriptUrl = `${base}opencascade.wasm.js`
    if (isDevBuild()) console.log('[loadOccWeb] fetching script:', scriptUrl)
    const resp = await fetch(scriptUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${scriptUrl}`)
    let text = await resp.text()

    // Strip the ES module export so it can run as a classic <script>.
    text = text.replace(/^export default \w+;\s*$/m, '')

    // Create a blob URL and inject as a classic script.
    const blob = new Blob([text], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = blobUrl
      const timeout = setTimeout(() => {
        URL.revokeObjectURL(blobUrl)
        // Redundant with the outer catch's console.error once this rejects;
        // kept dev-only so prod doesn't double-log the same failure.
        if (isDevBuild()) console.error('[loadOccWeb] script load timed out after 10s')
        reject(new Error(`timeout loading ${scriptUrl}`))
      }, 10_000)
      script.onload = () => {
        clearTimeout(timeout)
        URL.revokeObjectURL(blobUrl)
        if (isDevBuild()) console.log('[loadOccWeb] script loaded, window.opencascade =', typeof w.opencascade)
        resolve()
      }
      script.onerror = () => {
        clearTimeout(timeout)
        URL.revokeObjectURL(blobUrl)
        // Redundant with the outer catch's console.error once this rejects;
        // kept dev-only so prod doesn't double-log the same failure.
        if (isDevBuild()) console.error('[loadOccWeb] script load error')
        reject(new Error(`failed to load ${scriptUrl}`))
      }
      document.head.appendChild(script)
    })

    const factory = w.opencascade
    if (!factory) {
      if (isDevBuild()) console.warn('[loadOccWeb] script loaded but window.opencascade is', typeof factory)
      return null
    }
    if (isDevBuild()) console.log('[loadOccWeb] calling factory with locateFile')
    const mod = await factory({
      locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
    })
    if (isDevBuild()) console.log('[loadOccWeb] factory resolved, module ready')
    return mod as OccModule
  } catch (e) {
    // Genuine unrecoverable loader failure (the WASM kernel is unavailable);
    // kept ungated so it is not silently swallowed in production.
    console.error('[loadOccWeb] error:', e)
    return null
  }
})

export function loadOccWeb(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  return occWeb.load(base)
}
