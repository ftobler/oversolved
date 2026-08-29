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
 *
 * Crash handling mirrors the part solver too: a crash arms a short cooldown
 * that suppresses respawns for CRASH_COOLDOWN_MS, so a drag burst over a
 * deterministically trapping doc pays at most one respawn per window instead
 * of one Worker per drag tick. The next request after the window respawns
 * normally.
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

// Crash cooldown window: after a worker trap, refuse to respawn for this long
// (mirrors solverClient.ts). Only a crash arms it; cancels and watchdog
// timeouts clear one a crash armed earlier. A drag tick over a deterministically
// trapping doc fires solveAssembly per tick; the gate below collapses that
// burst to one respawn per window. Tests lower the window via
// setAnchorSolverCrashBackoffForTest().
const CRASH_COOLDOWN_MS = 2000
let crashCooldownMs = CRASH_COOLDOWN_MS
let workerCrashAt = 0  // Date.now() of the last worker trap; 0 = no crash yet

let relayHandlers: RelayHandlers | null = null

/**
 * Ownership stamp marking a bundle whose mesh buffers the main thread solely
 * references, applied by setRelayHandlers to whatever the registered
 * buildBundle handler resolves. Mirrors solverWorker's PACKED_FRESH: a symbol
 * key so structured clone drops it at the wire (it can never be picked up by
 * a clone crossing to or from a worker) and so it stays invisible to payload
 * equality checks. Only stamped bundles may have their buffers transferred.
 */
export const BUNDLE_FRESH = Symbol('anchor_bundle_fresh')

/**
 * Register the handlers that service the worker's relay requests. Single
 * consumer: only `useAssemblySolve` owns this slot, and it must pair every
 * call with `clearRelayHandlers` on unmount so a stale worker's relay requests
 * fail loudly instead of being serviced by a dead component.
 *
 * The buildBundle handler is wrapped rather than stored: every bundle it
 * resolves gets the BUNDLE_FRESH ownership stamp, and the transfer collector
 * refuses any bundle without it (see relayReplyTransferables). The stamp is
 * what turns the documented handler contract -- return only bundles whose
 * mesh buffers the main thread solely references -- into something machine
 * checked instead of trusted on an untyped cast.
 */
export function setRelayHandlers(handlers: RelayHandlers): void {
  relayHandlers = {
    ...handlers,
    buildBundle: async (doc_id, doc_rev, spec) => {
      const payload = await handlers.buildBundle(doc_id, doc_rev, spec)
      if (payload && typeof payload === 'object') {
        Object.defineProperty(payload, BUNDLE_FRESH, { value: true })
      }
      return payload
    },
  }
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
      // doc_rev/spec are optional on the wire type only because `partDocContent`
      // requests omit them; a buildBundle request missing either is a malformed
      // message, not a value to silently pass through as undefined.
      if (msg.doc_rev === undefined || msg.spec === undefined) {
        throw new Error('malformed buildBundle relay request: missing doc_rev/spec')
      }
      payload = await relayHandlers.buildBundle(msg.doc_id, msg.doc_rev, msg.spec)
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
 *
 * That ownership claim is enforced, not assumed: setRelayHandlers stamps every
 * bundle its buildBundle handler resolves with BUNDLE_FRESH, and anything
 * arriving without the stamp - a cached bundle, a hand-built object, a clone
 * from another generation - is never treated as fresh. It falls back to no
 * transfer (the post then structured-clones instead of detaching), which is
 * always safe, just slower; a stamped-shape bundle that reaches here unmarked
 * is logged so the missing stamp is loud.
 *
 * @internal test-only export: exercised directly by the stamp unit tests.
 */
export function relayReplyTransferables(subKind: AnchorRelayRequest['subKind'], res: AnchorRelayResponse): Transferable[] {
  if (subKind !== 'buildBundle' || !res.ok) return []
  const bundle = res.payload as (Partial<PartBundle> & { [BUNDLE_FRESH]?: true }) | null | undefined
  if (!bundle || bundle[BUNDLE_FRESH] !== true) {
    // Structurally transferable but unmarked: refuse the detach and say why.
    const looksTransferable = !!bundle && Array.isArray(bundle.bodies) &&
      bundle.bodies.some(b => b?.mesh?.vertices instanceof Float32Array)
    if (looksTransferable) {
      console.warn('relay transfer: bundle carries no freshness stamp; cloning instead of transferring', bundle)
    }
    return []
  }
  const bodies = bundle.bodies
  if (!bodies) return []  // stamped but empty: nothing to transfer
  const out: Transferable[] = []
  for (const body of bodies) {
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
      // last touch. Non-bundle replies (partDocContent, errors) pass no list,
      // and relayReplyTransferables refuses any bundle that arrived without
      // the BUNDLE_FRESH stamp (it clones instead of detaching).
      const transfer = relayReplyTransferables(msg.subKind, res)
      try {
        sender?.postMessage(res, transfer.length > 0 ? transfer : undefined)
      } catch {
        // The relay reply could not be posted to the anchor worker: a
        // DataCloneError from a detached transfer buffer, or a worker that went
        // away mid-post. Without an answer the worker's pending relay request
        // would hang until its own ceiling and, in production where the solve
        // watchdog is Infinity, spin the UI forever. Post a minimal, always
        // cloneable error reply so the worker rejects the request now.
        try {
          sender?.postMessage({
            kind: 'asr_relayRes',
            requestId: msg.requestId,
            ok: false,
            error: 'relay reply failed to post to the worker',
          })
        } catch {
          // Worker is gone: the solve is torn down elsewhere, nothing to answer.
        }
      }
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
  // A trap loses the worker's WASM state. Arm the respawn cooldown so a drag
  // burst over the same trapping doc does not spawn one worker per tick.
  workerCrashAt = Date.now()
  dropWorker(new Error('anchor solver worker crashed'))
}

function onTimeout(): void {
  // A request outran the watchdog: the Worker is presumed stuck in an
  // un-interruptible synchronous WASM loop. Killing it is the only recovery.
  // The cooldown clear is defensive (a crash's dropWorker already cleared the
  // watchdog timers, so no timeout can fire inside a crash-armed window); it
  // stays to match solverClient's documented intent that only a crash sets
  // the timestamp.
  dropWorker(new Error('anchor solver timed out'))
  workerCrashAt = 0
}

/** User-initiated cancel: kill the Worker so any in-flight solve is rejected. */
export function cancelAssemblySolver(): void {
  // Same defensive clear as onTimeout: while the window is armed, reSolve
  // rejects synchronously and no user cancel can land here, but a deliberate
  // drop lifts the cooldown if one got armed.
  dropWorker(new Error('assembly solve cancelled'))
  workerCrashAt = 0
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
  if (workerCrashAt !== 0 && Date.now() - workerCrashAt < crashCooldownMs) {
    // The last trap is still inside the cooldown: spawning a fresh worker now
    // just rebuilds and traps again. Reject instead so a drag burst over a
    // trapping doc pays one respawn per window.
    return Promise.reject(new Error('anchor solver worker crashed (backoff)'))
  }
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
  // Same for the crash cooldown: a fresh test starts with no crash recorded and
  // the production window. The backoff suite opts in via the setter below.
  workerCrashAt = 0
  crashCooldownMs = CRASH_COOLDOWN_MS
  workerFactory = factory ?? defaultFactory
}

/** @internal test-only: override the watchdog ceiling (ms). */
export function setAnchorSolverTimeoutForTest(ms: number): void {
  solveTimeoutMs = ms
}

/** @internal test-only: override the crash cooldown window (ms). */
export function setAnchorSolverCrashBackoffForTest(ms: number): void {
  crashCooldownMs = ms
}

/** @internal test-only: get the current relay handlers (for test assertions). */
export function getRelayHandlers(): RelayHandlers | null {
  return relayHandlers
}

/** @internal test-only: number of in-flight (unsettled) requests. */
export function getPendingCount(): number {
  return pending.size
}
