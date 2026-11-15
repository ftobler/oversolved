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

/** Fetch `<base>occt.js` and return its default export, or null when it has none. */
async function importFactory(base: string): Promise<OccFactory | null> {
  const scriptUrl = `${base}${OCC_JS}`
  const resp = await fetch(scriptUrl)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${scriptUrl}`)
  const text = await resp.text()
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  try {
    const mod = (await import(  /* @vite-ignore */ blobUrl)) as { default?: OccFactory }
    return typeof mod.default === 'function' ? mod.default : null
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
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
