/**
 * Forked-process runner for timeout-guarded solves. Runs in a child process
 * spawned by solveTimeout.ts so a synchronous WASM hang can be killed with
 * SIGKILL (unlike worker_threads terminate(), which cannot interrupt native
 * WASM execution). Started with --experimental-strip-types (for .ts files)
 * and --import of scripts/resolveAlias.register.mjs (for @/ aliases).
 *
 * Communicates with the parent via IPC (process.send / process.on).
 */

import { solveLocally, setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { loadProfileLoops } from '@/wasm-kernel/loadProfileLoops'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { setProfileLoopsBytes } from '@/kernel/profileLoopsRust'
import { extractErrorMessage } from '@/kernel/errors'

setOccLoader(loadOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())
// The profile-loop facade crosses the same package; a solve that builds a
// sketch area would otherwise throw its "not initialised" error here.
setProfileLoopsBytes(loadProfileLoops())

process.on('message', async ({ id, spec, options }) => {
  try {
    const result = await solveLocally(spec, options ?? {})
    process.send?.({ id, ok: true, result })
  } catch (e) {
    process.send?.({ id, ok: false, error: extractErrorMessage(e) })
  }
})
