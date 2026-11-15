/**
 * Worker-side loader for the OCCT build. The solver Worker installs this one;
 * the main thread has [[loadOccWeb]]. Both go through [[importOccModule]]: the
 * build is an ES module, so a Worker needs no DOM to load it.
 *
 * Progress lands in this thread's [[loadProgress]] store, which the Worker
 * bootstrap relays to the main thread.
 */

import type { OccModule } from './occTypes'
import { memoizedLoad } from './memoizedLoad'
import { importOccModule } from './importOccModule'

// Under the deploy base, e.g. /oversolved/ on Pages. Plain Node (the
// solve-timeout runner) has no import.meta.env, hence the optional chain.
const DEFAULT_BASE = `${import.meta.env?.BASE_URL ?? '/'}occ/`

const occWorker = memoizedLoad(async (base: string): Promise<OccModule | null> => {
  try {
    return await importOccModule(base)
  } catch (e) {
    // Non-fatal: the caller falls back to "local solver unavailable".
    console.error('[loadOccWorker] error:', e)
    return null
  }
})

export function loadOccWorker(base: string = DEFAULT_BASE): Promise<OccModule | null> {
  return occWorker.load(base)
}

/** Drop the Worker-side module so a trap recovery loads a fresh instance. */
export function resetOccWorker(): void {
  occWorker.reset()
}
