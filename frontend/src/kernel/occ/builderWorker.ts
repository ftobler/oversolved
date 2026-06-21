/**
 * The builder Worker entry: the single dedicated Worker that will host OCC.js
 * and the handle table off the main thread, so a solve never blocks the UI.
 *
 * Phase 2a proves only the smallest slice: it can extrude a square and
 * tessellate it, holding every shape through the [[HandleTable]] and reporting
 * the live-handle count so the host can assert no leaks across a loop. The
 * message-handling substance is [[runBuilderCommand]], a pure async function
 * that takes its OCC loader and table as dependencies, so it is unit-tested
 * with the fake module; the `self` bootstrap at the bottom is the only part
 * that needs a real Worker.
 *
 * Crash recovery (see migration notes): on a hard WASM trap the host discards
 * this Worker and respawns it, replaying the AST. Nothing here persists state
 * the host cannot rebuild.
 */

import { HandleTable } from './handleTable'
import { extractErrorMessage } from '../errors'
import { inWorker } from '../inWorker'
import { extrudeSquareAndTessellate, type ExtrudeOptions, type MeshResult } from './spikeBuild'
import { loadOccWeb } from './loadOccWeb'
import type { OccSpikeModule } from './occTypes'

export interface ExtrudeSquareRequest {
  id: number
  cmd: 'extrudeSquare'
  opts?: ExtrudeOptions
}

export type BuilderRequest = ExtrudeSquareRequest

export interface BuilderOkResponse {
  id: number
  ok: true
  result: MeshResult
  /** Live handles remaining after the command; the host asserts this is 0. */
  liveHandles: number
}

export interface BuilderErrResponse {
  id: number
  ok: false
  error: string
}

export type BuilderResponse = BuilderOkResponse | BuilderErrResponse

export interface BuilderDeps {
  loadOcc: () => Promise<OccSpikeModule | null>
  table: HandleTable
}

export async function runBuilderCommand(
  req: BuilderRequest,
  deps: BuilderDeps,
): Promise<BuilderResponse> {
  try {
    const oc = await deps.loadOcc()
    if (!oc) {
      return { id: req.id, ok: false, error: 'OCC.js module is not available' }
    }
    switch (req.cmd) {
      case 'extrudeSquare': {
        const { result, solid } = extrudeSquareAndTessellate(oc, deps.table, req.opts)
        // Spike: evict immediately so a loop of commands proves leak-freedom.
        deps.table.release(solid)
        return { id: req.id, ok: true, result, liveHandles: deps.table.liveCount() }
      }
      default:
        return { id: req.id, ok: false, error: `unknown command: ${(req as { cmd: string }).cmd}` }
    }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

// --- Worker bootstrap (skipped on the main thread / in tests) -------------

interface WorkerCtx {
  postMessage(message: BuilderResponse): void
  onmessage: ((e: MessageEvent<BuilderRequest>) => void) | null
}

if (inWorker()) {
  const ctx = globalThis as unknown as WorkerCtx
  const table = new HandleTable()
  ctx.onmessage = (e) => {
    void runBuilderCommand(e.data, { loadOcc: loadOccWeb, table }).then((res) => ctx.postMessage(res))
  }
}
