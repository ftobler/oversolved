/**
 * Forked-process runner for the chain fuzz watchdog (chainTimeout.ts). Runs in
 * a child process so a synchronous WASM hang can be SIGKILLed with the seed's
 * step known (the parent gets a progress message before every step). Started
 * with --experimental-strip-types and the @/ resolve-alias loader.
 *
 * Communicates with the parent via IPC (process.send / process.on).
 */

import { loadOcc } from '@/kernel/occ/loadOcc'
import { runChain, runPersistenceCheck } from '@/testing/robustnessFuzz/chain'

/** Loaded once, reused for every recipe the pooled child replays. */
let occPromise = null
function occ() {
  if (occPromise === null) occPromise = loadOcc()
  return occPromise
}

process.on('message', async ({ id, recipe }) => {
  try {
    const oc = await occ()
    if (!oc) {
      process.send?.({ id, ok: false, error: 'OCC.js is not installed; the chain fuzz cannot run' })
      return
    }
    const run = runChain(oc, recipe, {
      onStep: (step, kind) => process.send?.({ id, progress: { step, kind } }),
    })
    // The perturbed replay is a second full chain run, so it gets its own
    // progress mark: a hang there is reported as the persistence phase.
    let stale = []
    if (run.completed && run.violations.length === 0 && run.picks.length > 0) {
      process.send?.({ id, progress: { step: -1, kind: 'persistence' } })
      stale = runPersistenceCheck(oc, recipe, run.picks)
    }
    process.send?.({ id, ok: true, run, stale })
  } catch (e) {
    process.send?.({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})
