/**
 * The solver Worker entry: the single dedicated Worker that hosts the TS/WASM
 * kernel off the main thread, so a long solve never freezes the UI.
 *
 * The substance is [[handleSolveRequest]], a pure async function that takes the
 * solve engine as a dependency, so it is unit-tested with a fake engine; the
 * `self` bootstrap at the bottom is the only part that needs a real Worker.
 *
 * The engine ([[solveLocally]]) owns all the un-serializable state (OCC module,
 * HandleTable, last BuildState, cross-solve checkpoint cache) and lives here in
 * the Worker. Only the BuildResponse *minus* `_build_state` crosses back.
 *
 * Crash recovery (see migration notes): on a hard WASM trap the host discards
 * this Worker and respawns it, replaying the AST. Nothing here persists state
 * the host cannot rebuild from the main-thread AST.
 */

import { solveLocally, setOccLoader } from '../solveLocally'
import { loadOccWorker } from '../occ/loadOccWorker'
import type { SolveRequest, SolveResponse } from './solverProtocol'

/** The engine signature [[handleSolveRequest]] depends on (production: solveLocally). */
type SolveEngine = typeof solveLocally

export async function handleSolveRequest(
  req: SolveRequest,
  solve: SolveEngine,
): Promise<SolveResponse> {
  try {
    const response = await solve(req.spec, req.options)
    if (!response) {
      // OCC.js unavailable; main thread surfaces "local solver unavailable".
      return { id: req.id, ok: true, payload: null }
    }
    // Strip the Worker-only handle state; it stays here as the checkpoint cache.
    const { _build_state, ...payload } = response
    void _build_state
    return { id: req.id, ok: true, payload }
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// --- Worker bootstrap (skipped on the main thread / in tests) -------------

interface WorkerCtx {
  postMessage(message: SolveResponse): void
  onmessage: ((e: MessageEvent<SolveRequest>) => void) | null
}

function inWorker(): boolean {
  const g = globalThis as { WorkerGlobalScope?: unknown }
  return typeof g.WorkerGlobalScope !== 'undefined' && globalThis instanceof (g.WorkerGlobalScope as never)
}

if (inWorker()) {
  // Install the DOM-free OCC loader: the main-thread loadOccWeb uses
  // document/window, which do not exist here.
  setOccLoader(loadOccWorker)
  const ctx = globalThis as unknown as WorkerCtx
  ctx.onmessage = (e) => {
    void handleSolveRequest(e.data, solveLocally).then((res) => ctx.postMessage(res))
  }
}
