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

/** Loaded once per child; the pool retires a child after one recipe. */
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
    // progress mark: a hang there is reported as the persistence phase. It runs
    // whenever the chain BUILT a step that left a recorded pick, even when a
    // later step refused: those references live in a document a user could have
    // and a naming regression could break. A pick whose own step refused is
    // dropped first: its feature never built, so the reference is not part of
    // any document, and replaying it would only echo the refusal (some such
    // picks resolved in the base body and the solver then refused, others never
    // resolved at all). Unreached picks are only reported for completed base
    // runs; on a refused base run the refusal is already reported (see
    // runPersistenceCheck).
    const builtSteps = new Set(run.reports.filter((report) => report.status === 'built').map((report) => report.step))
    const persistentPicks = run.picks.filter((pick) => builtSteps.has(pick.step))
    let stale = []
    if (run.violations.length === 0 && persistentPicks.length > 0) {
      process.send?.({ id, progress: { step: -1, kind: 'persistence' } })
      stale = runPersistenceCheck(oc, recipe, persistentPicks, { reportUnreached: run.completed })
    }
    process.send?.({ id, ok: true, run, stale })
  } catch (e) {
    process.send?.({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})
