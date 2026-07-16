/**
 * Worker-thread entry for timeout-guarded solves. Runs in a Node.js
 * worker_thread so a synchronous WASM hang (e.g. OCC's
 * ShapeUpgrade_UnifySameDomain on self-overlapping geometry) can be killed by
 * terminating the thread. The parent side is solveTimeout.ts.
 *
 * Loads OCC.js and the Rust sketch solver once on first request; each
 * subsequent request reuses the same modules (the per-build checkpoint cache
 * in solveLocally is per-thread, so a terminated thread's state dies cleanly).
 */

import { parentPort } from 'node:worker_threads'

let occModule = null
let solveLocallyFn = null

async function ensureReady() {
  if (solveLocallyFn) return

  const { loadOcc } = await import('./occ/loadOcc.ts')
  occModule = await loadOcc()

  const { loadSolver } = await import('../wasm-kernel/loadSolver.ts')
  const { loadTopology } = await import('../wasm-kernel/loadTopology.ts')
  const { setSketchSolver, setSketchTopology } = await import('./features/sketch.ts')

  const solveBytes = loadSolver()
  const topoBytes = loadTopology()
  if (solveBytes) {
    setSketchSolver(solveBytes)
    setSketchTopology(topoBytes)
  }

  solveLocallyFn = (await import('./solveLocally.ts')).solveLocally
}

parentPort.on('message', async ({ id, spec, options }) => {
  try {
    await ensureReady()
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: `worker init: ${e.message}` })
    return
  }
  try {
    const result = await solveLocallyFn(spec, options ?? {})
    parentPort.postMessage({ id, ok: true, result })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message })
  }
})
