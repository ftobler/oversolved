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
 */

import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'
import type {
  SolveRequestOptions, SolveResponse,
  ExportRequestOptions, ExportResponse, WorkerRequest,
} from './solverProtocol'

/** Minimal Worker surface used here; lets tests inject a fake. */
export interface SolverWorkerLike {
  postMessage(msg: WorkerRequest): void
  onmessage: ((e: { data: SolveResponse | ExportResponse }) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate(): void
}

const EMPTY_BUILD_STATE: BuildState = Object.freeze({ feature_order: [], checkpoints: {} })

interface Pending {
  resolve: (r: BuildResponse | null) => void
  reject: (e: unknown) => void
}

interface ExportPending {
  resolve: (b: Uint8Array | null) => void
  reject: (e: unknown) => void
}

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
const pending = new Map<number, Pending>()
const exportPending = new Map<number, ExportPending>()

function onMessage(e: { data: SolveResponse | ExportResponse }): void {
  const res = e.data
  // Solve and export share the id counter, so an id lives in exactly one map;
  // route by whichever request is still in flight for it.
  const ep = exportPending.get(res.id)
  if (ep) {
    exportPending.delete(res.id)
    if (!res.ok) { ep.reject(new Error(res.error)); return }
    ep.resolve((res as ExportResponse & { ok: true }).bytes)
    return
  }
  const p = pending.get(res.id)
  if (!p) return  // stale or already-settled (e.g. after a crash drained pending)
  pending.delete(res.id)
  if (!res.ok) {
    p.reject(new Error(res.error))
    return
  }
  const payload = (res as SolveResponse & { ok: true }).payload
  if (payload === null) {
    p.resolve(null)
    return
  }
  p.resolve({ ...payload, _build_state: EMPTY_BUILD_STATE })
}

function onError(): void {
  // A hard Worker trap loses the checkpoint cache. Fail every in-flight solve
  // and export, and drop the Worker; the next request respawns a fresh one that
  // rebuilds from feature 0.
  const err = new Error('solver worker crashed')
  for (const p of pending.values()) p.reject(err)
  for (const p of exportPending.values()) p.reject(err)
  pending.clear()
  exportPending.clear()
  worker?.terminate()
  worker = null
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
 * Solve a document on the Worker. Returns the `BuildResponse` on success, or
 * `null` when the Worker can't be created or OCC.js is unavailable inside it
 * (caller surfaces "local solver unavailable").
 */
export function solveViaWorker(
  spec: Record<string, unknown>,
  options: SolveRequestOptions = {},
): Promise<BuildResponse | null> {
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise<BuildResponse | null>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, spec, options })
  })
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
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise<Uint8Array | null>((resolve, reject) => {
    exportPending.set(id, { resolve, reject })
    w.postMessage({ id, kind: 'export', spec, options })
  })
}

/** @internal test-only: inject a fake Worker factory and reset client state. */
export function setSolverWorkerForTest(
  factory: (() => SolverWorkerLike | null) | null,
): void {
  worker?.terminate()
  worker = null
  pending.clear()
  exportPending.clear()
  nextId = 1
  workerFactory = factory ?? defaultFactory
}
