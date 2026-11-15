/**
 * Main-thread loader for the OCCT build (the solver Worker has
 * [[loadOccWorker]]). Both go through [[importOccModule]], which imports the
 * ES-module `occt.js` and compiles `occt.wasm` with streaming progress.
 *
 * The artifact is a heavy, opt-in, gitignored file served under ``/occ/``;
 * it is NOT bundled. Provision with:
 *
 *   just install-occ
 */

import type { OccModule } from './occTypes'
import { isDevBuild } from '../isDevBuild'
import { memoizedLoad } from './memoizedLoad'
import { importOccModule, releaseOccFactory } from './importOccModule'

// Under the deploy base, e.g. /oversolved/ on Pages. Plain Node (the
// solve-timeout runner) has no import.meta.env, hence the optional chain.
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
    const mod = await importOccModule(base)
    if (isDevBuild()) console.log('[loadOccWeb]', mod ? 'module ready' : 'artifact has no factory')
    return mod
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

/** Drop the main-thread module so the next load instantiates a fresh one. The
 *  only caller is the trap recovery in solveLocally: a module that trapped has
 *  an undefined heap and must never be handed out again. */
export function resetOccWeb(): void {
  occWeb.reset()
  // The module's lifetime ends here, so the blob URL it was imported from can
  // go too; the next load imports a fresh one.
  releaseOccFactory()
}
