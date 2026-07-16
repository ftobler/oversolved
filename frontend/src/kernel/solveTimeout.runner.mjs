/**
 * Forked-process runner for timeout-guarded solves. Runs in a child process
 * spawned by solveTimeout.ts so a synchronous WASM hang can be killed with
 * SIGKILL (unlike worker_threads terminate(), which cannot interrupt native
 * WASM execution). Started with --experimental-strip-types (for .ts files)
 * and --loader (resolve-alias.loader.mjs for @/ aliases).
 *
 * Communicates with the parent via IPC (process.send / process.on).
 */

import { solveLocally, setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

setOccLoader(loadOcc)
setSketchSolver(loadSolver())
setSketchTopology(loadTopology())

process.on('message', async ({ id, spec, options }) => {
  try {
    const result = await solveLocally(spec, options ?? {})
    process.send?.({ id, ok: true, result })
  } catch (e) {
    process.send?.({ id, ok: false, error: e.message })
  }
})
