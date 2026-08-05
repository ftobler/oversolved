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

/** Send a relay request and await the main-thread response, or time out. */
function relayRequest(
  subKind: 'partDocContent' | 'buildBundle',
  params: { doc_id: string; doc_rev?: number; spec?: Record<string, unknown> },
  post: (msg: AnchorRelayRequest) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = nextRelayId++
    const timeout = setTimeout(() => {
      relayPending.delete(requestId)
      reject(new Error(`relay request '${subKind}' timed out after ${RELAY_TIMEOUT_MS}ms`))
    }, RELAY_TIMEOUT_MS)
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

/** Resolve or reject a pending relay request from the main-thread response. */
export function handleRelayResponse(msg: AnchorRelayResponse): void {
  const p = relayPending.get(msg.requestId)
  if (!p) return
  relayPending.delete(msg.requestId)
  if (msg.ok) p.resolve(msg.payload)
  else p.reject(new Error(msg.error))
}

export function createRelayService(
  post: (msg: AnchorRelayRequest) => void,
): RelayService {
  return {
    requestPartDoc(doc_id: string): Promise<Record<string, unknown>> {
      return relayRequest('partDocContent', { doc_id }, post) as Promise<Record<string, unknown>>
    },
    requestBuildBundle(doc_id: string, doc_rev: number, spec: Record<string, unknown>): Promise<unknown> {
      return relayRequest('buildBundle', { doc_id, doc_rev, spec }, post)
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

if (inWorker()) {
  // Init the mate solver WASM eagerly but don't block the first message.
  initAnchorSolver()

  const ctx = globalThis as unknown as WorkerCtx
  const actor = new WorkerActor()
  const relay = createRelayService((msg) => ctx.postMessage(msg))

  ctx.onmessage = (e) => {
    const msg = e.data
    if (msg.kind === 'asr_relayRes') {
      // Relay responses resolve promises outside the actor queue, they
      // just complete a pending relayRequest whose caller sits inside
      // an actor-serialized task.
      handleRelayResponse(msg)
    } else if (msg.kind === 'solveAssembly') {
      actor.run(
        () => handleSolveAssembly(msg, relay),
        (res) => { ctx.postMessage(res) },
        (err) => {
          ctx.postMessage({ id: msg.id, kind: 'solveAssembly', ok: false, error: extractErrorMessage(err) })
        },
      )
    }
  }
}
