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
 * Crash recovery: on a hard WASM trap the host discards
 * this Worker and respawns it, replaying the AST. Nothing here persists state
 * the host cannot rebuild from the main-thread AST.
 */

import { solveLocally, exportLocally, exportAssemblyLocally, setOccLoader } from '../solveLocally'
import { isDevBuild } from '../isDevBuild'
import { extractErrorMessage } from '../errors'
import { inWorker } from '../inWorker'
import { loadOccWorker } from '../occ/loadOccWorker'
import type {
  SolveRequest, SolveResponse, SolvePayload,
  ExportRequest, ExportResponse, WorkerRequest,
  BundleRequest, BundleResponse,
  ExportAssemblyRequest,
  FileBytes,
} from './solverProtocol'
import { SUPERSEDED_ERROR } from './solverProtocol'
import { toPartBundle } from '../partBundle'
import type { BodyResult } from '../../types/cad'

// The worker's per-generation import byte cache. The client sends each id's
// bytes once (fileDelta in solverClient); every request this generation then
// sees them here. The cache dies with the worker, which is exactly the lifetime
// the crash contract needs. Never populated from the anchor worker: the anchor
// relay resolves bytes on the main thread and posts them straight to this
// worker's BundleRequest.
const fileCache = new Map<string, Uint8Array>()

function absorbFiles(files: FileBytes | undefined): void {
  if (!files) return
  for (const [id, bytes] of Object.entries(files)) fileCache.set(id, bytes)
}

/** @internal test-only: run one message's files through the cache. */
export function absorbFilesForTest(files: FileBytes | undefined): void {
  absorbFiles(files)
}

/** @internal test-only: the live byte cache, so tests can assert what a
 *  generation has absorbed. */
export function fileCacheForTest(): ReadonlyMap<string, Uint8Array> {
  return fileCache
}

/** @internal test-only: empty the byte cache so tests start from a fresh generation. */
export function clearFileCacheForTest(): void {
  fileCache.clear()
}

/** The engine signature [[handleSolveRequest]] depends on (production: solveLocally). */
type SolveEngine = typeof solveLocally
/** The engine signature [[handleExportRequest]] depends on (production: exportLocally). */
type ExportEngine = typeof exportLocally

export async function handleSolveRequest(
  req: SolveRequest,
  solve: SolveEngine,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<SolveResponse> {
  try {
    const options = files ? { ...req.options, files } : req.options
    const response = await solve(req.spec, options)
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
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<ExportResponse> {
  try {
    const bytes = await exportFn(req.spec, req.options, files)
    return { id: req.id, ok: true, bytes }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

/** The transferable buffer in an export response (for postMessage's transfer arg). */
export function exportTransferables(res: ExportResponse): Transferable[] {
  return res.ok && res.bytes ? [res.bytes.buffer] : []
}

/** The engine signature [[handleExportAssemblyRequest]] depends on. */
type ExportAssemblyEngine = typeof exportAssemblyLocally

/**
 * Rebuild every part of an assembly, place it at its solved transform, and
 * serialise the compound. Shares the export response shape (and so the
 * zero-copy byte transfer) with the single-part export.
 */
export async function handleExportAssemblyRequest(
  req: ExportAssemblyRequest,
  exportFn: ExportAssemblyEngine,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<ExportResponse> {
  try {
    const bytes = await exportFn(req.parts, req.options, files)
    return { id: req.id, ok: true, bytes }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

// ─── bundle builder ───
// Builds a PartBundle from a PartDoc spec by running solveLocally and
// extracting per-body meshes + edge curves and the per-body anchor dicts.

export async function handleBundleRequest(
  req: BundleRequest,
  solve: SolveEngine,
  files?: ReadonlyMap<string, Uint8Array>,
): Promise<BundleResponse> {
  try {
    const response = await solve(req.spec, files ? { files } : {})
    if (!response) {
      return { id: req.id, ok: false, error: 'OCC.js unavailable' }
    }
    const bundle = toPartBundle(
      req.doc_id,
      req.content_hash,
      response.bodies as Record<string, BodyResult>,
    )
    return { id: req.id, ok: true, payload: bundle }
  } catch (e) {
    return { id: req.id, ok: false, error: extractErrorMessage(e) }
  }
}

/** The transferable ArrayBuffers in a bundle response (for postMessage's transfer arg). */
export function bundleTransferables(res: BundleResponse): Transferable[] {
  if (!res.ok) return []
  const out: Transferable[] = []
  for (const body of res.payload.bodies) {
    const m = body.mesh
    if (m.vertices instanceof Float32Array) out.push(m.vertices.buffer)
    if (m.indices instanceof Uint32Array) out.push(m.indices.buffer)
    if (m.faceIdsPerTriangle instanceof Uint32Array) out.push(m.faceIdsPerTriangle.buffer)
  }
  return out
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
//
// What gets transferred is derived from what packBody freshly packed, never
// from the array type alone: packBody stamps every mesh it creates with
// PACKED_FRESH, and the collectors transfer only stamped meshes. A producer
// that hands the worker a typed mesh it still owns can therefore never have its
// buffer detached behind its back.

type MeshVerts = [number, number, number][] | Float32Array
type MeshFaces = [number, number, number][] | Uint32Array

/**
 * Stamp packBody puts on the throwaway mesh object it creates. A symbol key so
 * structured clone drops it at the wire: the main thread never sees it, and a
 * clone of a packed response cannot pick the mark up by accident.
 */
const PACKED_FRESH = Symbol('packed_fresh')

function flattenVerts(verts: MeshVerts): Float32Array {
  if (verts instanceof Float32Array) return new Float32Array(verts)
  const out = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]
  }
  return out
}

function flattenFaces(faces: MeshFaces): Uint32Array {
  if (faces instanceof Uint32Array) return new Uint32Array(faces)
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
  // A mesh with no geometry arrays (the empty-mesh case) passes through
  // untouched; anything with data is flattened to fresh typed arrays whether
  // the producer emitted tuples or typed arrays, so the buffers we transfer
  // are always freshly created here.
  const hasVerts = vertices instanceof Float32Array || Array.isArray(vertices)
  const hasFaces = faces instanceof Uint32Array || Array.isArray(faces)
  if (!hasVerts || !hasFaces) return raw
  const packedMesh = {
    ...mesh,
    vertices: flattenVerts(vertices as MeshVerts),
    faces: flattenFaces(faces as MeshFaces),
  }
  Object.defineProperty(packedMesh, PACKED_FRESH, { value: true })
  return { ...body, mesh: packedMesh }
}

function packBodies(bodies: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [bid, body] of Object.entries(bodies)) out[bid] = packBody(body)
  return out
}

/** The transferable ArrayBuffers from a single body-dict (for postMessage's transfer arg). */
function collectBodyBuffers(bodies: Record<string, unknown> | undefined): Transferable[] {
  if (!bodies) return []
  const out: Transferable[] = []
  for (const body of Object.values(bodies)) {
    const mesh = (body as { mesh?: Record<PropertyKey, unknown> })?.mesh
    if (!mesh) continue
    const fresh = mesh[PACKED_FRESH] === true
    if (!fresh && (mesh.vertices instanceof Float32Array || mesh.faces instanceof Uint32Array)) {
      // A typed mesh with no fresh mark reached the transfer list: a producer
      // handed the worker an engine-owned mesh packBody never packed. Skip the
      // transfer (a silent detach would corrupt the producer's cached copy) and
      // make the regression loud.
      if (isDevBuild()) console.warn('mesh transfer: typed mesh was not freshly packed; skipping its buffers', mesh)
    }
    if (!fresh) continue
    if (mesh.vertices instanceof Float32Array) out.push(mesh.vertices.buffer)
    if (mesh.faces instanceof Uint32Array) out.push(mesh.faces.buffer)
  }
  return out
}

/** The transferable ArrayBuffers in a packed response (for postMessage's transfer arg). */
export function collectTransferables(res: SolveResponse): Transferable[] {
  if (!res.ok || !res.payload) return []
  return [
    ...collectBodyBuffers(res.payload.bodies),
    ...collectBodyBuffers(res.payload.pick_bodies),
  ]
}

// ─── Actor pattern: serializes solve + export requests ───
// The engine (solveLocally) owns mutable cross-solve state (HandleTable +
// last BuildState), and both solve and export touch the single-threaded OCC
// module. Concurrent requests would race on these shared resources. The Actor
// guarantees sequential access by running one job at a time.
//
// Queue policy: only the newest solve is ever wanted. A burst of solves (a
// sketch drag fires one per pointer move) would otherwise each be built in
// full, and the main thread throws all but the last away on arrival -- so a
// new solve drops the solves still waiting, and the user waits for one build
// instead of ten. Exports and bundle builds are distinct one-shot actions and
// are never dropped.
//
// The job already running is not interruptible: an OCC build is a single
// synchronous WASM call, and the only way out of it is terminating the whole
// Worker -- which throws away the checkpoint cache and forces a rebuild from
// feature 0. That trade only pays when the user explicitly asks for it, which
// is what the cancel button (`cancelSolver`) does.

/** One unit of Worker work: queued, then run to completion in isolation. */
export type ActorJob =
  | { supersedable: false; run: () => Promise<void> }
  /** A solve: a newer solve arriving while this one still waits replaces it,
   *  and `onSuperseded` sends the reply it will now never produce itself. */
  | { supersedable: true; run: () => Promise<void>; onSuperseded: () => void }

/**
 * A macrotask yield. Requests that arrived while the previous job held the
 * thread are still undelivered message events; letting them land before the
 * next job is picked is what makes the flush effective, otherwise the Actor
 * commits to a solve that the message right behind it already obsoleted.
 * MessageChannel rather than setTimeout because timers are throttled hard in
 * background tabs and a queued solve must not wait on that.
 */
function nextMacrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise(resolve => { setTimeout(resolve, 0) })
  }
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

export class WorkerActor {
  private queue: ActorJob[] = []
  private draining = false

  submit(job: ActorJob): void {
    if (job.supersedable) {
      const kept: ActorJob[] = []
      for (const queued of this.queue) {
        if (queued.supersedable) {
          // The reply must not be able to lose the new job or leave the
          // superseded one queued to run after its superseded reply was sent.
          try { queued.onSuperseded() } catch (e) {
            if (isDevBuild()) console.warn('superseded solve reply failed to post', e)
          }
        } else kept.push(queued)
      }
      this.queue = kept
    }
    this.queue.push(job)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        await nextMacrotask()
        const job = this.queue.shift()
        if (!job) break
        try {
          await job.run()
        } catch {
          // The handlers already turn engine failures into error responses, so
          // a throw here can only come from the reply itself (a payload that
          // will not clone). Swallow it: letting it escape would leave every
          // job queued behind it unrun and wedge the Worker for good.
        }
      }
    } finally {
      this.draining = false
    }
  }
}

/** An un-droppable job (export, bundle build): run it, then post its reply. */
function oneShot<T>(job: () => Promise<T>, respond: (res: T) => void): ActorJob {
  return { supersedable: false, run: async () => { respond(await job()) } }
}

// ─── Worker bootstrap (skipped on the main thread / in tests) ───

interface WorkerCtx {
  postMessage(message: SolveResponse | ExportResponse | BundleResponse, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
}

/**
 * Dispatch one Worker message to its handler. Exported so tests can drive the
 * dispatcher without a real Worker (the bootstrap below only runs in a Worker).
 * The solve branch is reached only through an explicit kind check: a malformed
 * message must not be mistaken for a solve, it is warned on and dropped.
 */
export function handleWorkerMessage(
  msg: WorkerRequest,
  post: (message: SolveResponse | ExportResponse | BundleResponse, transfer: Transferable[]) => void,
  actor: WorkerActor,
): void {
  // Every request shape may carry file bytes; absorb them first so all four
  // handlers below see the union of every file this generation has seen.
  absorbFiles(msg.files)
  if (msg.kind === 'export') {
    actor.submit(oneShot(
      () => handleExportRequest(msg, exportLocally, fileCache),
      (res) => { post(res, exportTransferables(res)) },
    ))
  } else if (msg.kind === 'exportAssembly') {
    actor.submit(oneShot(
      () => handleExportAssemblyRequest(msg, exportAssemblyLocally, fileCache),
      (res) => { post(res, exportTransferables(res)) },
    ))
  } else if (msg.kind === 'buildBundle') {
    actor.submit(oneShot(
      () => handleBundleRequest(msg, solveLocally, fileCache),
      (res) => { post(res, bundleTransferables(res)) },
    ))
  } else if (msg.kind === 'solve') {
    actor.submit({
      supersedable: true,
      run: async () => {
        const res = await handleSolveRequest(msg, solveLocally, fileCache)
        post(res, collectTransferables(res))
      },
      onSuperseded: () => {
        post({ id: msg.id, ok: false, error: SUPERSEDED_ERROR }, [])
      },
    })
  } else {
    if (isDevBuild()) console.warn('[solverWorker] unknown message kind', msg.kind)
  }
}

if (inWorker()) {
  // Install the DOM-free OCC loader: the main-thread loadOccWeb uses
  // document/window, which do not exist here.
  setOccLoader(loadOccWorker)
  const ctx = globalThis as unknown as WorkerCtx
  const actor = new WorkerActor()
  ctx.onmessage = (e) => {
    handleWorkerMessage(e.data, (res, transfer) => { ctx.postMessage(res, transfer) }, actor)
  }
}
