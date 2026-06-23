/**
 * Browser loader for opencascade.js via dynamic script injection.
 *
 * The Emscripten build is an IIFE that sets a global but ends with
 * ``export default opencascade;`` — a syntax error in a classic ``<script>``
 * tag. We fetch the text, strip the export, create a blob URL, and inject
 * that instead. After loading, ``window.opencascade`` is the factory.
 *
 * The artifact is a heavy, opt-in, gitignored file served under ``/occ/``;
 * it is NOT bundled. Provision with:
 *
 *   npm run occ:install && npm run occ:provision
 */

import type { OccModule } from './occTypes'

const DEFAULT_BASE = '/occ/'

let cached: Promise<OccModule | null> | null = null

export function loadOccWeb(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  if (cached) {
    console.log('[loadOccWeb] returning cached promise')
    return cached
  }
  if (import.meta.env.MODE === 'test') {
    console.log('[loadOccWeb] test environment, skipping')
    return Promise.resolve(null)
  }
  console.log('[loadOccWeb] starting load from', base)
  cached = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any

      if (w.opencascade) {
        console.log('[loadOccWeb] window.opencascade already present, calling factory')
        return await w.opencascade({
          locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
        }) as OccModule
      }

      const scriptUrl = `${base}opencascade.wasm.js`
      console.log('[loadOccWeb] fetching script:', scriptUrl)
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
          console.error('[loadOccWeb] script load timed out after 10s')
          reject(new Error(`timeout loading ${scriptUrl}`))
        }, 10_000)
        script.onload = () => {
          clearTimeout(timeout)
          URL.revokeObjectURL(blobUrl)
          console.log('[loadOccWeb] script loaded, window.opencascade =', typeof w.opencascade)
          resolve()
        }
        script.onerror = () => {
          clearTimeout(timeout)
          URL.revokeObjectURL(blobUrl)
          console.error('[loadOccWeb] script load error')
          reject(new Error(`failed to load ${scriptUrl}`))
        }
        document.head.appendChild(script)
      })

      const factory = w.opencascade
      if (!factory) {
        console.warn('[loadOccWeb] script loaded but window.opencascade is', typeof factory)
        return null
      }
      console.log('[loadOccWeb] calling factory with locateFile')
      const mod = await factory({
        locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
      })
      console.log('[loadOccWeb] factory resolved, module ready')
      return mod as OccModule
    } catch (e) {
      console.error('[loadOccWeb] error:', e)
      return null
    }
  })()
  return cached
}
