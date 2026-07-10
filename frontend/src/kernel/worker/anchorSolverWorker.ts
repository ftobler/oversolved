/**
 * The anchor solver Worker entry: a separate, Rust-only Worker that hosts the
 * mate solver WASM. No OCC, no `solveLocally`, no `HandleTable`. The Worker
 * owns the `bundleCache` (IndexedDb) and the mate solve state. It communicates
 * with a main-thread client (`anchorSolverClient.ts`) that relays bundle-build
 * requests to the OCC bundle-builder worker and fetches PartDoc content from
 * the document store (main-thread-only).
 *
 * Stage 5b: real orchestration via `solveAssembly` — bundle get/miss/build/
 * migrate chain, anchor resolve + stale flagging, solve_mate call, transform
 * application, and assemblyCache for warm starts.
 */

import { inWorker } from '../inWorker'
import { extractErrorMessage } from '../errors'
import { initAnchorSolver, getMateSolver } from '../../wasm-kernel/anchorSolver'
import { solveAssembly } from '../solveAssembly'
import type { AssemblyBuildResponse } from '../solveAssembly'
import type { Transform3D } from '../../types/cad'
import type {
  SolveAssemblyRequest,
  AssemblySolveResponse,
  AnchorRelayRequest,
  AnchorRelayResponse,
  AssemblyWorkerRequest,
  AssemblyWorkerResponse,
} from './solverProtocol'

// ─── RelayService ────────────────────────────────────────────────────────
// The worker cannot touch the document store (main-thread-only) or talk to
// the OCC bundle-builder worker. Requests are brokered via postMessage to
// the main thread, which handles them and posts back.

export interface RelayService {
  requestPartDoc(doc_id: string): Promise<Record<string, unknown>>
  requestBuildBundle(doc_id: string, doc_rev: number, spec: Record<string, unknown>): Promise<unknown>
}

let nextRelayId = 1
const relayPending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()

/** Send a relay request and await the main-thread response. */
function relayRequest(
  subKind: 'partDocContent' | 'buildBundle',
  params: { doc_id: string; doc_rev?: number; spec?: Record<string, unknown> },
  post: (msg: AnchorRelayRequest) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = nextRelayId++
    relayPending.set(requestId, { resolve, reject })
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

// ─── solveAssembly handler ───────────────────────────────────────────────
// Stage 5b: real orchestration — bundle get/miss/build/migrate, anchor
// resolve, mate solve via WASM, transform application.

export async function handleSolveAssembly(
  req: SolveAssemblyRequest,
  relay: RelayService,
): Promise<AssemblySolveResponse> {
  try {
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

// ─── Actor pattern ───────────────────────────────────────────────────────
// Serializes solveAssembly requests and guards mutable `assemblyCache`
// state from concurrent access.

interface AssemblyCacheEntry {
  lastTransforms: Record<string, Transform3D>
  lastMateResults: Record<string, unknown>
}

class WorkerActor {
  private queue: Promise<void> = Promise.resolve()
  readonly assemblyCache = new Map<string, AssemblyCacheEntry>()

  run<T>(job: () => Promise<T>, respond: (res: T) => void): void {
    this.queue = this.queue.then(() => job().then(respond))
  }
}

// ─── Worker bootstrap (skipped on the main thread / in tests) ────────────

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
      // Relay responses resolve promises outside the actor queue — they
      // just complete a pending relayRequest whose caller sits inside
      // an actor-serialized task.
      handleRelayResponse(msg)
    } else if (msg.kind === 'solveAssembly') {
      actor.run(
        () => handleSolveAssembly(msg, relay),
        (res) => { ctx.postMessage(res) },
      )
    }
  }
}
