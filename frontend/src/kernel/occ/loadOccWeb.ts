/**
 * Browser loader for opencascade.js via dynamic script injection.
 *
 * The Emscripten build is a classic IIFE script (not an ES module), so it
 * must be loaded via a ``<script>`` tag. It sets ``window.opencascade`` as a
 * factory function; we call it with ``locateFile`` to point at the .wasm.
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
  // Skip in test environments (jsdom has no network layer for script fetches).
  if (import.meta.env.MODE === 'test') {
    console.log('[loadOccWeb] test environment, skipping')
    return Promise.resolve(null)
  }
  console.log('[loadOccWeb] starting load from', base)
  cached = (async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    try {
      const w = window as any

      if (w.opencascade) {
        console.log('[loadOccWeb] window.opencascade already present, calling factory')
        return await (w.opencascade as any)({
          locateFile: (p: string) => (p.endsWith('.wasm') ? `${base}opencascade.wasm.wasm` : p),
        })
      }

      console.log('[loadOccWeb] injecting script tag:', `${base}opencascade.wasm.js`)
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = `${base}opencascade.wasm.js`
        const timeout = setTimeout(() => {
          console.error('[loadOccWeb] script load timed out after 10s')
          reject(new Error(`timeout loading ${script.src}`))
        }, 10_000)
        script.onload = () => {
          clearTimeout(timeout)
          console.log('[loadOccWeb] script loaded, window.opencascade =', typeof w.opencascade)
          resolve()
        }
        script.onerror = () => {
          clearTimeout(timeout)
          console.error('[loadOccWeb] script load error')
          reject(new Error(`failed to load ${script.src}`))
        }
        document.head.appendChild(script)
      })

      const factory = w.opencascade
      if (!factory) {
        console.warn('[loadOccWeb] script loaded but window.opencascade is', typeof factory)
        return null
      }
      console.log('[loadOccWeb] calling factory with locateFile')
      const mod = await (factory as any)({
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

/** Reset the memoized module (tests / hot-reload). */
export function resetOccWeb(): void {
  cached = null
}
