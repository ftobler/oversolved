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

import { solveLocally, exportLocally, setOccLoader } from '../solveLocally'
import { extractErrorMessage } from '../errors'
import { loadOccWorker } from '../occ/loadOccWorker'
import type {
  SolveRequest, SolveResponse, SolvePayload,
  ExportRequest, ExportResponse, WorkerRequest,
} from './solverProtocol'

/** The engine signature [[handleSolveRequest]] depends on (production: solveLocally). */
type SolveEngine = typeof solveLocally
/** The engine signature [[handleExportRequest]] depends on (production: exportLocally). */
type ExportEngine = typeof exportLocally

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
    const { _build_state, ...rest } = response
    void _build_state
    const payload: SolvePayload = {
      ...rest,
      bodies: packBodies(rest.bodies),
      ...(rest.pick_bodies ? { pick_bodies: packBodies(rest.pick_bodies) } : {}),
    }
    return { id: req.id, ok: true, payload }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

/**
 * Build + serialise a document to STEP/STL bytes Worker-side. The bytes are the
 * only payload; their backing buffer is transferred (zero-copy) back. A `null`
 * result (OCC.js absent or no body) crosses as `bytes: null`.
 */
export async function handleExportRequest(
  req: ExportRequest,
  exportFn: ExportEngine,
): Promise<ExportResponse> {
  try {
    const bytes = await exportFn(req.spec, req.options)
    return { id: req.id, ok: true, bytes }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

/** The transferable buffer in an export response (for postMessage's transfer arg). */
export function exportTransferables(res: ExportResponse): Transferable[] {
  return res.ok && res.bytes ? [res.bytes.buffer] : []
}

// ─── mesh transfer ───
// The kernel emits each body mesh as nested tuple arrays (`[x,y,z][]` verts,
// `[a,b,c][]` triangles). Across postMessage those structured-clone into a deep
// copy of thousands of tiny arrays. Convert the two heavy arrays to flat typed
// arrays so the clone is one contiguous buffer that we then *transfer*
// (zero-copy); the main-thread `bodyGeometry` zero-copy branch consumes them
// straight as GPU buffers, skipping its tuple validate-and-rebuild loop.
//
// Non-mutating by construction: the builder shares each mesh object with its
// cross-solve tess cache + checkpoint snapshots, so we shallow-clone the body
// and mesh and build *fresh* typed arrays. The cached tuple meshes are never
// touched, and only the throwaway wire buffers are neutered by the transfer.

function flattenVerts(verts: [number, number, number][]): Float32Array {
  const out = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]
  }
  return out
}

function flattenFaces(faces: [number, number, number][]): Uint32Array {
  const out = new Uint32Array(faces.length * 3)
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i]
    out[i * 3] = f[0]; out[i * 3 + 1] = f[1]; out[i * 3 + 2] = f[2]
  }
  return out
}

function packBody(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const body = raw as Record<string, unknown>
  const mesh = body.mesh as Record<string, unknown> | undefined
  if (!mesh) return raw
  const { vertices, faces } = mesh
  // Only the kernel's tuple form needs packing; anything else passes through.
  if (!Array.isArray(vertices) || !Array.isArray(faces)) return raw
  return {
    ...body,
    mesh: {
      ...mesh,
      vertices: flattenVerts(vertices as [number, number, number][]),
      faces: flattenFaces(faces as [number, number, number][]),
    },
  }
}

function packBodies(bodies: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [bid, body] of Object.entries(bodies)) out[bid] = packBody(body)
  return out
}

function pushBodyBuffers(bodies: Record<string, unknown> | undefined, out: Transferable[]): void {
  if (!bodies) return
  for (const body of Object.values(bodies)) {
    const mesh = (body as { mesh?: Record<string, unknown> })?.mesh
    if (!mesh) continue
    if (mesh.vertices instanceof Float32Array) out.push(mesh.vertices.buffer)
    if (mesh.faces instanceof Uint32Array) out.push(mesh.faces.buffer)
  }
}

/** The transferable ArrayBuffers in a packed response (for postMessage's transfer arg). */
export function collectTransferables(res: SolveResponse): Transferable[] {
  if (!res.ok || !res.payload) return []
  const out: Transferable[] = []
  pushBodyBuffers(res.payload.bodies, out)
  pushBodyBuffers(res.payload.pick_bodies, out)
  return out
}

// ─── Actor pattern: serializes solve + export requests ──────────────────
// The engine (solveLocally) owns mutable cross-solve state (HandleTable +
// last BuildState), and both solve and export touch the single-threaded OCC
// module. Concurrent requests would race on these shared resources. The Actor
// guarantees sequential access by chaining every job onto the previous one's
// completion promise.

class WorkerActor {
  private queue: Promise<void> = Promise.resolve()

  run<T>(job: () => Promise<T>, respond: (res: T) => void): void {
    this.queue = this.queue.then(() => job().then(respond))
  }
}

// --- Worker bootstrap (skipped on the main thread / in tests) -------------

interface WorkerCtx {
  postMessage(message: SolveResponse | ExportResponse, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
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
  const actor = new WorkerActor()
  ctx.onmessage = (e) => {
    const msg = e.data
    if (msg.kind === 'export') {
      actor.run(
        () => handleExportRequest(msg, exportLocally),
        (res) => { ctx.postMessage(res, exportTransferables(res)) },
      )
    } else {
      actor.run(
        () => handleSolveRequest(msg, solveLocally),
        (res) => { ctx.postMessage(res, collectTransferables(res)) },
      )
    }
  }
}
