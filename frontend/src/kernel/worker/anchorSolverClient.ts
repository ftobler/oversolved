/**
 * Main-thread client for the anchor solver Worker. Drop-in entry point for
 * `solveAssembly`: it sends mates and assemblyId, the worker runs the real
 * orchestration. The Worker is Rust-only, no OCC, no `solveLocally`,
 * no `HandleTable`.
 *
 * Cross-worker relay: the anchor solver worker cannot access the document
 * store (main-thread-only) or talk to the OCC bundle-builder worker directly.
 * When it needs PartDoc content or a bundle build, it sends a relay request
 * via postMessage; this client handles it, calling injected relay handlers,
 * and posts the response back.
 *
 * Hang handling: a mate solve is a synchronous WASM loop inside the worker; if
 * it never settles, the main-thread promise is stuck and the user sees an
 * eternal spinner. Mirroring the part solver (`solverClient.ts`), the ONLY
 * recovery is to kill the Worker, and the ONLY thing that does it is the user
 * pressing cancel (`cancelAssemblySolver`, wired to the `LoadingOverlay` the
 * assembly editor mounts, which reads `useSolverStore`). There is deliberately
 * no automatic ceiling: a legit heavy solve and a hung one are
 * indistinguishable from here. The watchdog machinery is kept intact behind
 * `solveTimeoutMs` (Infinity in production, lowered by
 * `setAnchorSolverTimeoutForTest`) so the drop-and-respawn path stays covered
 * by tests and can be re-armed by setting a ceiling.
 */

import type {
  SolveAssemblyRequest,
  AssemblySolveOkResponse,
  AnchorRelayRequest,
  AnchorRelayResponse,
  AssemblyWorkerRequest,
  AssemblyWorkerResponse,
  PartInputSpec,
} from './solverProtocol'
import type { MateSpec } from '../solveAssembly'
import type { PartBundle } from '../partBundle'
import { extractErrorMessage } from '../errors'

/** Minimal Worker surface used here; lets tests inject a fake. */
export interface AnchorSolverWorkerLike {
  postMessage(msg: AssemblyWorkerRequest, transfer?: Transferable[]): void
  onmessage: ((e: { data: AssemblyWorkerResponse }) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate(): void
}

/** Main-thread handlers for worker-side relay requests. */
export interface RelayHandlers {
  partDocContent: (doc_id: string) => Promise<Record<string, unknown>>
  buildBundle: (doc_id: string, doc_rev: number, spec: Record<string, unknown>) => Promise<unknown>
}

function defaultFactory(): AnchorSolverWorkerLike | null {
  try {
    if (typeof Worker === 'undefined') return null
    return new Worker(new URL('./anchorSolverWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as AnchorSolverWorkerLike
  } catch {
    return null
  }
}

let workerFactory: () => AnchorSolverWorkerLike | null = defaultFactory
let worker: AnchorSolverWorkerLike | null = null
let nextId = 1

interface Pending {
  resolve: (res: AssemblySolveOkResponse) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}
const pending = new Map<number, Pending>()

// Watchdog ceiling for a single worker request. Infinity disables the automated
// timeout, which is the production setting - see the header on why cancelling is
// the user's call. Tests lower it via setAnchorSolverTimeoutForTest(). The
// Infinity case must skip the timer entirely rather than pass it through:
// `setTimeout(fn, Infinity)` is spec-equivalent to `setTimeout(fn, 0)`, which
// would kill every request immediately.
let solveTimeoutMs = Infinity

let relayHandlers: RelayHandlers | null = null

/**
 * Register the handlers that service the worker's relay requests. Single
 * consumer: only `useAssemblySolve` owns this slot, and it must pair every
 * call with `clearRelayHandlers` on unmount so a stale worker's relay requests
 * fail loudly instead of being serviced by a dead component.
 */
export function setRelayHandlers(handlers: RelayHandlers): void {
  relayHandlers = handlers
}

/** Unregister the relay handlers; relay requests then fail loudly. */
export function clearRelayHandlers(): void {
  relayHandlers = null
}

async function handleRelay(msg: AnchorRelayRequest): Promise<AnchorRelayResponse> {
  try {
    if (!relayHandlers) throw new Error('no relay handlers registered')
    let payload: unknown
    if (msg.subKind === 'partDocContent') {
      payload = await relayHandlers.partDocContent(msg.doc_id)
    } else if (msg.subKind === 'buildBundle') {
      payload = await relayHandlers.buildBundle(msg.doc_id, msg.doc_rev!, msg.spec!)
    } else {
      throw new Error(`unknown relay subKind: ${msg.subKind}`)
    }
    return {
      kind: 'asr_relayRes',
      requestId: msg.requestId,
      ok: true,
      payload,
    }
  } catch (e) {
    return {
      kind: 'asr_relayRes',
      requestId: msg.requestId,
      ok: false,
      error: extractErrorMessage(e),
    }
  }
}

/**
 * The mesh buffers of a `buildBundle` relay reply that the reply can transfer
 * (zero-copy) to the anchor worker. Mirrors `bundleTransferables`
 * (`solverWorker.ts`) over the `PartBundle` shape. Only a successful
 * `buildBundle` reply carries them; `partDocContent` and error replies
 * transfer nothing.
 *
 * Double-transfer guard: this is only safe because the main thread holds the
 * bundle's sole reference here - the relay handler returns the OCC worker's
 * reply straight into this post, and the solver client dropped its pending
 * entry on arrival. A bundle retained anywhere else must never be transferred.
 */
function relayReplyTransferables(subKind: AnchorRelayRequest['subKind'], res: AnchorRelayResponse): Transferable[] {
  if (subKind !== 'buildBundle' || !res.ok) return []
  const bundle = res.payload as Partial<PartBundle> | null | undefined
  if (!bundle || !Array.isArray(bundle.bodies)) return []
  const out: Transferable[] = []
  for (const body of bundle.bodies) {
    const m = body?.mesh
    if (m?.vertices instanceof Float32Array) out.push(m.vertices.buffer)
    if (m?.indices instanceof Uint32Array) out.push(m.indices.buffer)
    if (m?.faceIdsPerTriangle instanceof Uint32Array) out.push(m.faceIdsPerTriangle.buffer)
  }
  return out
}

function onMessage(e: { data: AssemblyWorkerResponse }): void {
  const msg = e.data
  if (msg.kind === 'asr_relay') {
    // Tie the reply to the worker that asked. The module `worker` is read at
    // resolve time, and after a crash + respawn it can name a new generation;
    // a stale reply would then resolve a NEW relay's slot. Capture the sender
    // when the request arrives: a crash terminated + nulled it, so the stale
    // reply is dropped instead of misdelivered.
    const sender = worker
    handleRelay(msg).then((res) => {
      // Ownership contract: a buildBundle reply's mesh buffers are transferred
      // (zero-copy) into the anchor worker's clone, detaching them on the main
      // thread. The main thread holds the bundle's only reference, so nothing
      // may read those buffers after this post - the transfer list is the
      // last touch. Non-bundle replies (partDocContent, errors) pass no list.
      const transfer = relayReplyTransferables(msg.subKind, res)
      sender?.postMessage(res, transfer.length > 0 ? transfer : undefined)
    })
    return
  }
  // Only a solveAssembly response may settle a pending solve: a future response
  // kind carrying a colliding id must not resolve the wrong entry.
  if (msg.kind !== 'solveAssembly') return
  const p = pending.get(msg.id)
  if (!p) return
  if (p.timer) clearTimeout(p.timer)
  pending.delete(msg.id)
  if (msg.ok) {
    p.resolve(msg)
  } else {
    p.reject(new Error(msg.error ?? 'worker returned an error response'))
  }
}

// Fail every in-flight request and drop the Worker; the next request respawns a
// fresh one. Shared by the crash trap, the hang watchdog, and the user cancel.
function dropWorker(err: Error): void {
  for (const p of pending.values()) {
    if (p.timer) clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
  worker?.terminate()
  worker = null
}

function onError(): void {
  dropWorker(new Error('anchor solver worker crashed'))
}

function onTimeout(): void {
  // A request outran the watchdog: the Worker is presumed stuck in an
  // un-interruptible synchronous WASM loop. Killing it is the only recovery.
  dropWorker(new Error('anchor solver timed out'))
}

/** User-initiated cancel: kill the Worker so any in-flight solve is rejected. */
export function cancelAssemblySolver(): void {
  dropWorker(new Error('assembly solve cancelled'))
}

function ensureWorker(): AnchorSolverWorkerLike | null {
  if (worker) return worker
  const w = workerFactory()
  if (!w) return null
  w.onmessage = onMessage
  w.onerror = onError
  worker = w
  return worker
}

/**
 * Solve an assembly on the anchor solver worker. Sends mates and
 * assemblyId alongside the parts; the worker runs the real orchestration
 * (bundle building, anchor resolution, mate solve, transform application).
 * Returns `null` when no worker can be created (caller surfaces "local solver
 * unavailable").
 */
export function solveAssemblyViaWorker(
  assemblyId: string,
  parts: PartInputSpec[],
  revs: Record<string, number>,
  mates: MateSpec[],
): Promise<AssemblySolveOkResponse | null> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise<AssemblySolveOkResponse | null>((resolve, reject) => {
    const msg: SolveAssemblyRequest = { id, kind: 'solveAssembly', assemblyId, parts, revs, mates }
    // Post before registering the pending entry: a throw here (a non-cloneable
    // payload, or a worker that died between ensureWorker and the post) must
    // reject the promise rather than leak an entry that can never settle. The
    // reply cannot arrive before the set below anyway - onmessage is a
    // macrotask and this code runs without yielding.
    try {
      w.postMessage(msg)
    } catch (e) {
      reject(e)
      return
    }
    const timer = isFinite(solveTimeoutMs) ? setTimeout(onTimeout, solveTimeoutMs) : null
    pending.set(id, { resolve, reject, timer })
  })
}

/** @internal test-only: inject a fake Worker factory and reset client state. */
export function setAnchorSolverWorkerForTest(
  factory: (() => AnchorSolverWorkerLike | null) | null,
): void {
  if (worker) {
    // Detach the old worker's reply path before dropping it: nextId restarts at
    // 1 below, so a late reply from the old generation would otherwise settle
    // the NEW worker's id-1 entry. With the handler detached it is dropped.
    worker.onmessage = null
    worker.terminate()
  }
  worker = null
  for (const p of pending.values()) {
    if (p.timer) clearTimeout(p.timer)
    p.reject(new Error('worker reset by test'))
  }
  pending.clear()
  nextId = 1
  relayHandlers = null
  // The production default, so a test that says nothing about the watchdog gets
  // production behaviour. The timeout suite opts in explicitly.
  solveTimeoutMs = Infinity
  workerFactory = factory ?? defaultFactory
}

/** @internal test-only: override the watchdog ceiling (ms). */
export function setAnchorSolverTimeoutForTest(ms: number): void {
  solveTimeoutMs = ms
}

/** @internal test-only: get the current relay handlers (for test assertions). */
export function getRelayHandlers(): RelayHandlers | null {
  return relayHandlers
}

/** @internal test-only: number of in-flight (unsettled) requests. */
export function getPendingCount(): number {
  return pending.size
}
