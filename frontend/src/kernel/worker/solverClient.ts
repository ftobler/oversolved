/**
 * Main-thread client for the solver Worker. Drop-in replacement for the
 * in-process `solveLocally` from `useSolver`'s view: same `(spec, options) ->
 * BuildResponse | null` shape, but the work runs off-thread so a long solve
 * never freezes the UI.
 *
 * The Worker owns the real `_build_state` (OCC handles + checkpoint cache);
 * the main thread never reads it, so responses arrive without it and this
 * client fills a frozen empty placeholder to satisfy the `BuildResponse` type.
 *
 * Crash handling: a Worker-level error rejects every in-flight solve and drops
 * the Worker; the next solve respawns it and rebuilds from feature 0 (the AST
 * lives in main-thread JS, so no user work is lost).
 *
 * Hang handling: some OCC operations (notably ShapeUpgrade_UnifySameDomain's
 * face merge on self-overlapping geometry, e.g. a circular_array whose axis runs
 * through the source body) can spin forever inside the WASM engine rather than
 * throw. That loop is synchronous and un-interruptible from JS, so the only way
 * to recover is to kill the Worker -- and the ONLY thing that kills it is the
 * user pressing cancel (`cancelSolver`, surfaced by the solver overlay after a
 * few seconds of solving). There is deliberately no automatic ceiling: a legit
 * heavy solve and a hung one are indistinguishable from here, and every fixed
 * ceiling either kills the honest solve or waits so long it may as well not
 * exist. The user can tell them apart, so the user decides.
 *
 * The watchdog machinery is kept intact behind `solveTimeoutMs` (Infinity in
 * production, lowered by `setSolverTimeoutForTest`) so the drop-and-respawn path
 * stays covered by tests and can be re-armed by setting a ceiling -- nothing
 * else has to change to bring it back.
 */

import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'
import type {
  SolveRequestOptions, SolveResponse, SolveOkResponse,
  ExportRequestOptions, ExportResponse, ExportOkResponse, WorkerRequest,
  BundleResponse, BundleOkResponse,
  AssemblyExportPartSpec,
} from './solverProtocol'
import type { PartBundle } from '../partBundle'

/** Minimal Worker surface used here; lets tests inject a fake. */
export interface SolverWorkerLike {
  postMessage(msg: WorkerRequest): void
  onmessage: ((e: { data: SolveResponse | ExportResponse | BundleResponse }) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate(): void
}

const EMPTY_BUILD_STATE: BuildState = Object.freeze({ feature_order: [], checkpoints: {} })

/** Successful response carrying the value to extract for an in-flight request. */
type OkResponse = SolveOkResponse | ExportOkResponse | BundleOkResponse

// One in-flight request. `resolve` already closes over the per-request extractor
// (solve fills `_build_state`, export pulls bytes), so the shared dispatcher in
// `onMessage` stays request-shape agnostic.
interface Pending {
  resolve: (res: OkResponse) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

// Watchdog ceiling for a single Worker request. Infinity disables the automated
// timeout, which is the production setting -- see the header on why cancelling is
// the user's call. Tests lower it via setSolverTimeoutForTest(). The Infinity
// case must skip the timer entirely rather than pass it through:
// `setTimeout(fn, Infinity)` is spec-equivalent to `setTimeout(fn, 0)`, which
// would kill every request immediately.
let solveTimeoutMs = Infinity

function defaultFactory(): SolverWorkerLike | null {
  try {
    if (typeof Worker === 'undefined') return null
    return new Worker(new URL('./solverWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as SolverWorkerLike
  } catch {
    return null
  }
}

let workerFactory: () => SolverWorkerLike | null = defaultFactory
let worker: SolverWorkerLike | null = null
let nextId = 1
// Solve and export share the id counter, so an id lives in exactly one entry.
const pending = new Map<number, Pending>()

function onMessage(e: { data: SolveResponse | ExportResponse | BundleResponse }): void {
  const res = e.data
  const p = pending.get(res.id)
  if (!p) return  // stale or already-settled (e.g. after a crash drained pending)
  if (p.timer) clearTimeout(p.timer)
  pending.delete(res.id)
  if (!res.ok) {
    p.reject(new Error(res.error))
    return
  }
  p.resolve(res)
}

// Fail every in-flight request and drop the Worker; the next request respawns a
// fresh one that rebuilds from feature 0 (the AST lives in main-thread JS, so no
// user work is lost). Shared by the crash trap and the hang watchdog.
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
  // A hard Worker trap loses the checkpoint cache.
  dropWorker(new Error('solver worker crashed'))
}

function onTimeout(): void {
  // A request outran the watchdog: the Worker is presumed stuck in an
  // un-interruptible synchronous loop (see the file header). Killing it is the
  // only recovery.
  dropWorker(new Error('solver worker timed out'))
}

/** User-initiated cancel: kill the Worker so any in-flight solve is rejected. */
export function cancelSolver(): void {
  dropWorker(new Error('solve cancelled'))
}

function ensureWorker(): SolverWorkerLike | null {
  if (worker) return worker
  const w = workerFactory()
  if (!w) return null
  w.onmessage = onMessage
  w.onerror = onError
  worker = w
  return worker
}

/**
 * Post a request to the Worker and resolve once its reply arrives. `extract`
 * pulls the caller's value out of the successful response. Resolves `null` when
 * no Worker can be created (caller surfaces "local solver unavailable").
 */
function sendRequest<T>(
  buildMsg: (id: number) => WorkerRequest,
  extract: (res: OkResponse) => T,
): Promise<T | null> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise<T | null>((resolve, reject) => {
    const timer = isFinite(solveTimeoutMs) ? setTimeout(onTimeout, solveTimeoutMs) : null
    pending.set(id, { resolve: (res) => resolve(extract(res)), reject, timer })
    w.postMessage(buildMsg(id))
  })
}

/**
 * Solve a document on the Worker. Returns the `BuildResponse` on success, or
 * `null` when the Worker can't be created or OCC.js is unavailable inside it
 * (caller surfaces "local solver unavailable").
 */
export function solveViaWorker(
  spec: Record<string, unknown>,
  options: SolveRequestOptions = {},
): Promise<BuildResponse | null> {
  return sendRequest(
    (id) => ({ id, spec, options }),
    (res) => {
      const payload = (res as SolveOkResponse).payload
      return payload === null ? null : { ...payload, _build_state: EMPTY_BUILD_STATE }
    },
  )
}

/**
 * Build + serialise a document to STEP/STL bytes on the Worker. Returns the
 * bytes, or `null` when the Worker can't be created, OCC.js is unavailable, or
 * the document produced no solid body (caller surfaces an error notice).
 */
export function exportViaWorker(
  spec: Record<string, unknown>,
  options: ExportRequestOptions,
): Promise<Uint8Array | null> {
  return sendRequest(
    (id) => ({ id, kind: 'export', spec, options }),
    (res) => (res as ExportOkResponse).bytes,
  )
}

/**
 * Build every part of an assembly on the Worker, place each at its solved
 * transform, and serialise the compound to STEP/STL bytes. Returns `null` when
 * the Worker can't be created, OCC.js is unavailable, or no part produced a
 * solid body (caller surfaces an error notice).
 */
export function exportAssemblyViaWorker(
  parts: AssemblyExportPartSpec[],
  options: ExportRequestOptions,
): Promise<Uint8Array | null> {
  return sendRequest(
    (id) => ({ id, kind: 'exportAssembly', parts, options }),
    (res) => (res as ExportOkResponse).bytes,
  )
}

/**
 * Build a `PartBundle` (meshes + edges + anchors) for a part document on the OCC
 * bundle-builder worker. The anchor solver worker cannot reach OCC itself, so
 * the main thread relays its cache-miss builds through here.
 */
export function buildBundleViaWorker(
  spec: Record<string, unknown>,
  doc_id: string,
  doc_rev: number,
): Promise<PartBundle | null> {
  return sendRequest(
    (id) => ({ id, kind: 'buildBundle', spec, doc_id, doc_rev }),
    (res) => (res as BundleOkResponse).payload,
  )
}

/** @internal test-only: inject a fake Worker factory and reset client state. */
export function setSolverWorkerForTest(
  factory: (() => SolverWorkerLike | null) | null,
): void {
  worker?.terminate()
  worker = null
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer)
  pending.clear()
  nextId = 1
  // The production default, so a test that says nothing about the watchdog gets
  // production behaviour. The timeout suite opts in explicitly.
  solveTimeoutMs = Infinity
  workerFactory = factory ?? defaultFactory
}

/** @internal test-only: override the watchdog ceiling (ms). */
export function setSolverTimeoutForTest(ms: number): void {
  solveTimeoutMs = ms
}
