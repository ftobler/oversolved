/**
 * A throwaway import run on an idle kernel, so the first real STEP import of a
 * session does not pay the cold path.
 *
 * WASM code starts in the baseline tier and is promoted only once it runs hot,
 * and the kernel's own JS is interpreted until it does too; the first import of
 * a session runs the STEP reader, the transfer, the mesher and the face/edge
 * readers cold (the phase bench measured the 7-face fixture at 271 ms first,
 * 99 ms repeated). This runs that path once on a small part the kernel builds
 * itself, so no STEP bytes ship for it.
 *
 * Each step is short and separate so the Worker can drop the rest the moment a
 * real request arrives (solverWorker.ts, the `warmup` lane). Nothing here
 * touches the cross-solve checkpoint cache or the persistent handle table: every
 * shape lives in the step's own scope and private table and is gone after it.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { makeBoxAt, makeCylinder } from './primitives'
import { booleanWithDiff } from './booleans'
import { stepBytesToShapeWithIdentity, stepShapeToBytes } from './stepIo'
import { readFaceFacts } from './faceFacts'
import { readShapeFaceMetadata, solidFaceEdgeData, solidToEdges, solidToMesh, solidToVertices } from './tessellation'
import type { OccModule } from './occTypes'
import type { OccHandle } from './handleTable'

/** What one step leaves for the next: plain bytes, never a handle. */
export interface WarmUpState {
  step?: Uint8Array
}

/** One warm-up step; it may read and fill the shared state. */
export type WarmUpStep = (oc: OccModule, state: WarmUpState) => void

/** Build a plate with a through hole (planes and a cylinder, a seam) and write it as STEP. */
function buildAndWrite(oc: OccModule, state: WarmUpState): void {
  const scope = new DisposeScope()
  try {
    const plate = scope.track(makeBoxAt(oc, scope, [0, 0, 0], 20, 12, 4))
    const drill = scope.track(makeCylinder(oc, scope, [10, 6, -1], [0, 0, 1], 3, 6))
    state.step = stepShapeToBytes(oc, scope, scope.track(booleanWithDiff(oc, scope, plate, drill, 'cut').shape))
  } finally {
    scope.dispose()
  }
}

/** Read it back and run the import's metadata and render passes on it. */
function readAndRender(oc: OccModule, state: WarmUpState): void {
  if (!state.step) return
  const scope = new DisposeScope()
  const table = new HandleTable()
  let handle: OccHandle | null = null
  try {
    // The read shape is untracked (the caller owns it); the private table takes it.
    handle = table.register(stepBytesToShapeWithIdentity(oc, scope, state.step).shape)
    const solid = table.get(handle)
    readShapeFaceMetadata(oc, scope, solid)
    const faceFacts = readFaceFacts(oc, solid)
    solidToMesh(oc, table, handle, { faceFacts })
    const edges = solidToEdges(oc, table, handle, { computeConvexity: true })
    solidToVertices(oc, table, handle)
    solidFaceEdgeData(oc, table, handle, edges.edge_queries, faceFacts)
  } finally {
    if (handle !== null) table.release(handle)
    scope.dispose()
  }
}

export const WARM_UP_STEPS: readonly WarmUpStep[] = [buildAndWrite, readAndRender]
