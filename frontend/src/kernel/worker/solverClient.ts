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
import type { SolveRequest, SolveRequestOptions, SolveResponse } from './solverProtocol'

/** Minimal Worker surface used here; lets tests inject a fake. */
export interface SolverWorkerLike {
  postMessage(msg: SolveRequest): void
  onmessage: ((e: { data: SolveResponse }) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate(): void
}

const EMPTY_BUILD_STATE: BuildState = Object.freeze({ feature_order: [], checkpoints: {} })

interface Pending {
  resolve: (r: BuildResponse | null) => void
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

function onMessage(e: { data: SolveResponse }): void {
  const res = e.data
  const p = pending.get(res.id)
  if (!p) return  // stale or already-settled (e.g. after a crash drained pending)
  pending.delete(res.id)
  if (!res.ok) {
    p.reject(new Error(res.error))
    return
  }
  if (res.payload === null) {
    p.resolve(null)
    return
  }
  p.resolve({ ...res.payload, _build_state: EMPTY_BUILD_STATE })
}

function onError(): void {
  // A hard Worker trap loses the checkpoint cache. Fail every in-flight solve
  // and drop the Worker; the next solveViaWorker respawns a fresh one that
  // rebuilds from feature 0.
  const err = new Error('solver worker crashed')
  for (const p of pending.values()) p.reject(err)
  pending.clear()
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

/** @internal test-only: inject a fake Worker factory and reset client state. */
export function setSolverWorkerForTest(
  factory: (() => SolverWorkerLike | null) | null,
): void {
  worker?.terminate()
  worker = null
  pending.clear()
  nextId = 1
  workerFactory = factory ?? defaultFactory
}
