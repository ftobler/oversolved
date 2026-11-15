/**
 * Instantiate the provisioned OCCT build from a served base URL: the one path
 * both browser loaders ([[loadOccWeb]] on the main thread, [[loadOccWorker]] in
 * the solver Worker) share.
 *
 * `occt.js` is a real ES module (`export default occt`), so it is imported as
 * is, with no script tag and no export stripping. It is fetched as text and
 * imported off a blob URL rather than by its own URL: a dynamic import of a
 * file under `public/` is something the Vite dev server refuses to transform,
 * and the blob keeps dev and production on the same path. The factory is the
 * module's `default`.
 *
 * That blob URL is kept alive for the module's lifetime rather than revoked
 * right after the import: the module can still resolve something against its
 * own `import.meta.url` (and DevTools re-reads script sources for console stack
 * frames), which a revoked URL answers with a 404. It is one ~110 KB blob per
 * thread, imported once; [[releaseOccFactory]] ends it when a loader reset drops
 * the module.
 *
 * The wasm is compiled before the factory runs: [[compileOccWasm]] fetches it
 * with streaming compilation and reports progress through [[loadProgress]], and
 * the compiled module goes to the factory's `instantiateWasm` hook so the
 * runtime never re-fetches it. Progress lands in the calling thread's store;
 * the Worker bootstrap relays its own to the main thread.
 *
 * Both files are same-origin under `<base>` (`/occ/` by default); nothing loads
 * from the release host at runtime.
 */

import type { OccModule } from './occTypes'
import { compileOccWasm, makeInstantiateWasm } from './wasmCompile'
import {
  beginOccLoad,
  reportOccCompiling,
  reportOccDownload,
  reportOccFailed,
  reportOccReady,
} from './loadProgress'

/** The provisioned file names (frontend/occ.pin.json `artifacts`). */
export const OCC_JS = 'occt.js'
export const OCC_WASM = 'occt.wasm'

type OccFactory = (config: unknown) => Promise<OccModule>

/** The blob URL the live `occt.js` module was imported from, if any. */
let factoryBlobUrl: string | null = null

/**
 * Revoke the live `occt.js` blob URL. A loader reset is the end of the module's
 * lifetime; the next import makes a fresh URL. Kept exported rather than
 * revoked eagerly because the module may still resolve against its own URL
 * while it is live (see the module header).
 */
export function releaseOccFactory(): void {
  if (factoryBlobUrl) URL.revokeObjectURL(factoryBlobUrl)
  factoryBlobUrl = null
}

/** Fetch `<base>occt.js` and return its default export, or null when it has none. */
async function importFactory(base: string): Promise<OccFactory | null> {
  const scriptUrl = `${base}${OCC_JS}`
  const resp = await fetch(scriptUrl)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${scriptUrl}`)
  const text = await resp.text()
  const previous = factoryBlobUrl
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  factoryBlobUrl = blobUrl
  const mod = (await import(  /* @vite-ignore */ blobUrl)) as { default?: OccFactory }
  // The previous URL is released only now: a failed attempt leaves the old
  // module live, so its URL must outlive the attempt.
  if (previous) URL.revokeObjectURL(previous)
  return typeof mod.default === 'function' ? mod.default : null
}

/**
 * Load and instantiate the module under `base`, reporting the load phases.
 * Resolves null when the artifact has no factory; throws on a fetch, compile or
 * instantiation failure (the caller logs and degrades).
 */
export async function importOccModule(base: string): Promise<OccModule | null> {
  const wasmUrl = `${base}${OCC_WASM}`
  beginOccLoad()
  try {
    const factory = await importFactory(base)
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
    reportOccFailed()
    throw e
  }
}
