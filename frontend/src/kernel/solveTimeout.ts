/**
 * Timeout guard for synchronous solve calls (solveLocally / build).
 *
 * The browser Worker client (solverClient.ts) already has a 30 s watchdog that
 * terminates a hung Web Worker, but direct in-process solve calls (e.g.
 * fullDocParity.test.ts) are unprotected: if OCC's
 * ShapeUpgrade_UnifySameDomain or any other synchronous WASM call spins
 * forever, the event loop is blocked and even vitest's testTimeout cannot fire
 * -- the whole CI job wedges.
 *
 * This module runs the solve inside a Node.js worker_thread and terminates the
 * thread after a configurable ceiling (default 30 s). A terminated worker's
 * V8 isolate + WASM instance die cleanly and the parent gets a timeout error
 * instead of an unrecoverable hang.
 *
 * The worker is created lazily and reused across requests; the per-build
 * checkpoint cache in solveLocally lives per-thread, so a terminated worker
 * drops its cache and the next request spawns a fresh thread that rebuilds
 * from scratch. This mirrors the drop-and-respawn pattern of the browser
 * Worker client.
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { BuildResponse } from './builder'

/** Minimal Worker surface used here; lets tests inject a fake. */
export interface SolveWorkerLike {
  postMessage(msg: unknown): void
  onmessage: ((e: { data: unknown }) => void) | null
  onerror: ((e: unknown) => void) | null
  onexit: ((code: number) => void) | null
  terminate(): void
}

const DEFAULT_TIMEOUT_MS = 30000

interface Pending {
  resolve: (result: BuildResponse | null) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerMsg {
  id: number
  ok: boolean
  result?: BuildResponse | null
  error?: string
}

function defaultFactory(): SolveWorkerLike | null {
  try {
    if (typeof Worker === 'undefined') return null
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'solveTimeout.worker.mjs',
    )
    const raw = new Worker(workerPath)
    const wrapper: SolveWorkerLike = {
      postMessage(msg: unknown) { raw.postMessage(msg) },
      onmessage: null,
      onerror: null,
      onexit: null,
      terminate() { void raw.terminate() },
    }
    raw.on('message', (msg: unknown) => {
      wrapper.onmessage?.({ data: msg })
    })
    raw.on('error', (e: unknown) => {
      wrapper.onerror?.(e)
    })
    raw.on('exit', (code: number) => {
      wrapper.onexit?.(code)
      if (code !== 0) dropWorker(new Error(`solve worker exited with code ${code}`))
    })
    return wrapper
  } catch {
    return null
  }
}

let workerFactory: () => SolveWorkerLike | null = defaultFactory
let worker: SolveWorkerLike | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function onMessage(e: { data: unknown }): void {
  const msg = e.data as WorkerMsg
  const p = pending.get(msg.id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(msg.id)
  if (msg.ok) {
    p.resolve(msg.result ?? null)
  } else {
    p.reject(new Error(msg.error ?? 'solve failed'))
  }
}

function onError(): void {
  dropWorker(new Error('solve worker crashed'))
}

function dropWorker(err: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
  worker?.terminate()
  worker = null
}

function ensureWorker(): SolveWorkerLike {
  if (worker) return worker
  const w = workerFactory()
  if (!w) throw new Error('worker_threads unavailable')
  w.onmessage = onMessage
  w.onerror = onError
  worker = w
  return worker
}

/**
 * Solve a document through solveLocally, guarded by a thread-level timeout.
 *
 * The worker loads OCC.js + the Rust sketch solver on its first request; each
 * subsequent request reuses them. Returns the BuildResponse on success, or
 * null when OCC.js is unavailable. Rejects with a timeout error when the
 * worker does not respond within `timeoutMs`.
 */
export function solveWithTimeout(
  spec: Record<string, unknown>,
  options?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BuildResponse | null> {
  return new Promise<BuildResponse | null>((resolve, reject) => {
    let w: SolveWorkerLike
    try {
      w = ensureWorker()
    } catch (e) {
      reject(e)
      return
    }
    const id = nextId++
    const timer = setTimeout(() => {
      dropWorker(new Error(`solve timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, spec, options })
  })
}

/**
 * Terminate the pooled worker. Call between test suites to get a cold start.
 */
export function disposeWorker(): void {
  dropWorker(new Error('disposed'))
}

/** @internal test-only: inject a fake Worker factory and reset client state. */
export function setSolveWorkerForTest(
  factory: (() => SolveWorkerLike | null) | null,
): void {
  worker?.terminate()
  worker = null
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  nextId = 0
  workerFactory = factory ?? defaultFactory
}
