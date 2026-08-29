/**
 * The anchor solver Worker entry: a separate, Rust-only Worker that hosts the
 * mate solver WASM. No OCC, no `solveLocally`, no `HandleTable`. The Worker
 * owns the `bundleCache` (IndexedDb) and the mate solve state. It communicates
 * with a main-thread client (`anchorSolverClient.ts`) that relays bundle-build
 * requests to the OCC bundle-builder worker and fetches PartDoc content from
 * the document store (main-thread-only).
 *
 * Hosts the real `solveAssembly` orchestration: bundle get/miss/build/migrate
 * chain, anchor resolve + stale flagging, solve_mate call, transform
 * application.
 */

import { inWorker } from '../inWorker'
import { extractErrorMessage } from '../errors'
import { initAnchorSolver, getMateSolver } from '../../wasm-kernel/anchorSolver'
import { solveAssembly } from '../solveAssembly'
import type { AssemblyBuildResponse } from '../solveAssembly'
import { bundleCachePutIfAbsent } from '../bundleCache'
import type { PartBundle } from '../partBundle'
import type {
  SolveAssemblyRequest,
  AssemblySolveResponse,
  AnchorRelayRequest,
  AnchorRelayResponse,
  AssemblyWorkerRequest,
  AssemblyWorkerResponse,
} from './solverProtocol'

// ─── RelayService ───
// The worker cannot touch the document store (main-thread-only) or talk to
// the OCC bundle-builder worker. Requests are brokered via postMessage to
// the main thread, which handles them and posts back.

export interface RelayService {
  requestPartDoc(doc_id: string): Promise<Record<string, unknown>>
  requestBuildBundle(doc_id: string, doc_rev: number, spec: Record<string, unknown>): Promise<unknown>
}

let nextRelayId = 1
const relayPending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()

// A relay that outran its budget is remembered briefly so a late reply can
// still salvage the finished work. Only buildBundle entries exist (a partDoc
// reply carries nothing to cache): its reply is a built PartBundle that
// nothing else caches, so a timeout no longer throws it away (the next solve
// would rebuild it). Entries self-evict via LATE_RELAY_GRACE_MS, which is also
// what bounds the map; the original promise is already rejected.
const lateRelay = new Map<number, { doc_id: string; doc_rev?: number }>()

// The relay id counter lives in this worker's own realm and restarts at 1 on
// every spawn, so two worker generations could mint colliding ids. Solve ids
// come from the client's monotonic counter, so pushing the relay counter past
// `solveId * 1000` on each solve keeps every generation's ids in its own band:
// even a misdelivered stale reply cannot resolve a live entry in a respawned
// worker.
function scopeRelayIdsToGeneration(solveId: number): void {
  nextRelayId = Math.max(nextRelayId, solveId * 1000)
}

// If the main thread never answers (tab backgrounded mid-navigation, a
// listener that got detached, etc), an un-timed-out relay would hang
// `solveAssembly` forever with `isSolving: true` and no banner. Exported so
// tests can drive it with fake timers instead of waiting out the real delay.
export const RELAY_TIMEOUT_MS = 30_000

// A bundle build is the most expensive relay hop (an OCC evaluation of the
// part), so it gets a longer budget than the document-fetch hop. Scaled off
// the per-service timeout so an armed override shortens both kinds together.
export const BUILD_BUNDLE_TIMEOUT_SCALE = 2

// How long a timed-out buildBundle stays rememberable for a late reply to be
// cached; also what bounds the lateRelay map. Shorter than the relay budget:
// a build that takes longer than this to land is effectively lost work.
export const LATE_RELAY_GRACE_MS = 5_000

/** Send a relay request and await the main-thread response, or time out. */
function relayRequest(
  subKind: 'partDocContent' | 'buildBundle',
  params: { doc_id: string; doc_rev?: number; spec?: Record<string, unknown> },
  post: (msg: AnchorRelayRequest) => void,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = nextRelayId++
    const timeout = setTimeout(() => {
      relayPending.delete(requestId)
      // The solve that asked already gave up, but a buildBundle build may
      // still be finishing: remember the request long enough for its late
      // reply to be cached. A dead main thread produces no reply at all, so
      // the grace timer just evicts the entry.
      if (subKind === 'buildBundle') {
        lateRelay.set(requestId, { doc_id: params.doc_id, doc_rev: params.doc_rev })
        setTimeout(() => { lateRelay.delete(requestId) }, LATE_RELAY_GRACE_MS)
      }
      reject(new Error(`relay request '${subKind}' timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    relayPending.set(requestId, {
      resolve: (val) => { clearTimeout(timeout); resolve(val) },
      reject: (err) => { clearTimeout(timeout); reject(err) },
    })
    post({
      kind: 'asr_relay',
      requestId,
      subKind,
      doc_id: params.doc_id,
      doc_rev: params.doc_rev,
      spec: params.spec,
    })
  })
}

/**
 * Resolve or reject a pending relay request from the main-thread response.
 * A reply for an already-timed-out request returns the pending cache-save
 * promise (if any) so tests can await the salvage; the caller treats it as
 * fire-and-forget.
 */
export function handleRelayResponse(msg: AnchorRelayResponse): Promise<void> | undefined {
  const p = relayPending.get(msg.requestId)
  if (p) {
    relayPending.delete(msg.requestId)
    if (msg.ok) p.resolve(msg.payload)
    else p.reject(new Error(msg.error))
    return undefined
  }
  // No pending entry: the request already timed out. Only buildBundle relays
  // create a late entry (partDocContent has nothing to cache), so a match
  // here is a finished build whose reply can salvage the work.
  const late = lateRelay.get(msg.requestId)
  if (!late) return undefined
  lateRelay.delete(msg.requestId)
  // An error reply has nothing to cache and is dropped; only then does the
  // ok arm narrow to a payload-bearing response.
  if (!msg.ok) return undefined
  const bundle = msg.payload as Partial<PartBundle> | null | undefined
  // Shape guard mirroring the main thread's relay reply check: only a bundle
  // with a `bodies` array, for the requested doc/rev, is plausible enough to
  // cache. A malformed or mismatched late reply is dropped.
  if (!bundle || !Array.isArray(bundle.bodies)) return undefined
  if (bundle.doc_id !== late.doc_id || bundle.doc_rev !== late.doc_rev) return undefined
  return cacheLateBundle(bundle as PartBundle)
}

async function cacheLateBundle(bundle: PartBundle): Promise<void> {
  try {
    // Atomic if-absent: the read and write share one transaction, so the late
    // salvage can never overwrite a bundle a concurrent or later solve just
    // wrote (a migrated record, for instance). The old guard read
    // `bundleCacheHas` then `bundleCachePut` as two transactions; a solve
    // committing between them left the salvage free to clobber the migrated
    // write. putIfAbsent collapses that window to zero.
    await bundleCachePutIfAbsent(bundle)
  } catch (e) {
    // Best effort: the solve already failed, so a failed cache write must not
    // surface as an unhandled rejection in the worker.
    console.warn('failed to cache a late relayed bundle', e)
  }
}

export function createRelayService(
  post: (msg: AnchorRelayRequest) => void,
  relayTimeoutMs: number = RELAY_TIMEOUT_MS,
): RelayService {
  return {
    requestPartDoc(doc_id: string): Promise<Record<string, unknown>> {
      return relayRequest('partDocContent', { doc_id }, post, relayTimeoutMs) as Promise<Record<string, unknown>>
    },
    requestBuildBundle(doc_id: string, doc_rev: number, spec: Record<string, unknown>): Promise<unknown> {
      return relayRequest(
        'buildBundle',
        { doc_id, doc_rev, spec },
        post,
        relayTimeoutMs * BUILD_BUNDLE_TIMEOUT_SCALE,
      )
    },
  }
}

// ─── solveAssembly handler ───
// Real orchestration: bundle get/miss/build/migrate, anchor resolve, mate
// solve via WASM, transform application.

export async function handleSolveAssembly(
  req: SolveAssemblyRequest,
  relay: RelayService,
): Promise<AssemblySolveResponse> {
  try {
    scopeRelayIdsToGeneration(req.id)
    await initAnchorSolver()
    const solver = getMateSolver()

    const result: AssemblyBuildResponse = await solveAssembly(
      req.parts,
      req.revs,
      req.mates || [],
      relay,
      solver,
    )

    return {
      id: req.id,
      kind: 'solveAssembly',
      ok: true,
      payload: {
        transforms: result.transforms,
        bodies: result.bodies,
        anchors: result.anchors,
        mateResults: result.mateResults,
        solveError: result.solveError,
      },
    }
  } catch (e) {
    return { id: req.id, kind: 'solveAssembly', ok: false, error: extractErrorMessage(e) }
  }
}

// ─── Actor pattern ───
// Serializes solveAssembly requests onto one chained promise so two solves
// never race each other inside the same Worker.

export class WorkerActor {
  private queue: Promise<void> = Promise.resolve()

  // `.catch` keeps `this.queue` itself always resolving, unconditionally.
  // Without it, one rejection (job() throwing, or respond() throwing on a
  // non-cloneable payload) would poison the chain: every `.then` chained
  // after a rejected promise never runs, so every solve requested after the
  // first failure would silently never execute. `onError`, when given, lets
  // the caller still surface the failure (e.g. post an error response)
  // instead of it being swallowed outright - and even an onError that throws
  // cannot reject `this.queue`, so the guarantee holds for a hostile or
  // non-cloneable error callback too.
  run<T>(job: () => Promise<T>, respond: (res: T) => void, onError?: (err: unknown) => void): void {
    this.queue = this.queue
      .then(() => job().then(respond))
      .catch(err => {
        try { onError?.(err) } catch (e) {
          console.warn('error callback threw while reporting a failed solve', e)
        }
      })
  }
}

// ─── Worker bootstrap (skipped on the main thread / in tests) ───

interface WorkerCtx {
  postMessage(message: AssemblyWorkerResponse): void
  onmessage: ((e: MessageEvent<AssemblyWorkerRequest>) => void) | null
}

/**
 * Dispatch one Worker message to its handler. Exported so tests can drive the
 * dispatcher without a real Worker (the bootstrap below only runs in a Worker).
 * The relay service is built per message from the post callback; the pending
 * relay map and id counter it wraps are module-level, so it carries no state.
 * An unknown kind is dropped, loudly, instead of silently.
 */
export function handleWorkerMessage(
  msg: AssemblyWorkerRequest,
  post: (msg: AssemblyWorkerResponse) => void,
  actor: WorkerActor,
): void {
  if (msg.kind === 'asr_relayRes') {
    // Relay responses resolve promises outside the actor queue, they
    // just complete a pending relayRequest whose caller sits inside
    // an actor-serialized task.
    handleRelayResponse(msg)
  } else if (msg.kind === 'solveAssembly') {
    actor.run(
      () => handleSolveAssembly(msg, createRelayService(post)),
      (res) => { post(res) },
      (err) => {
        post({ id: msg.id, kind: 'solveAssembly', ok: false, error: extractErrorMessage(err) })
      },
    )
  } else {
    // The union is exhaustive, so TS narrows msg to never here; log the kind
    // through the raw message so a malformed one is observable.
    console.warn('[anchorSolverWorker] unknown message kind', (msg as { kind?: unknown }).kind)
  }
}

if (inWorker()) {
  // Init the mate solver WASM eagerly but don't block the first message.
  initAnchorSolver()

  const ctx = globalThis as unknown as WorkerCtx
  const actor = new WorkerActor()
  ctx.onmessage = (e) => {
    handleWorkerMessage(e.data, (msg) => { ctx.postMessage(msg) }, actor)
  }
}
