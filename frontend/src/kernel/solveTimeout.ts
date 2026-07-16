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
 * This module runs the solve in a forked child process and kills it with
 * SIGKILL after a configurable ceiling (default 30 s). Unlike
 * worker_threads.terminate() (which uses v8::Isolate::TerminateExecution and
 * cannot interrupt synchronous WASM), SIGKILL forcibly stops the OS process
 * and its native code. A terminated child drops its checkpoint cache; the next
 * request spawns a fresh process.
 *
 * The child is started with --experimental-strip-types (Node 22.6+) and a
 * custom --loader that maps @/ to ./src/, so it can import the full source
 * tree without vitest or a build step.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { BuildResponse } from './builder'

/** Minimal child-process surface used here; lets tests inject a fake. */
export interface SolveChildLike {
  send(msg: Record<string, unknown>): void
  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'error', cb: (e: unknown) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  kill(signal?: NodeJS.Signals): void
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

function runnerPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'solveTimeout.runner.mjs',
  )
}

function loaderPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../resolve-alias.loader.mjs',
  )
}

function defaultFactory(): SolveChildLike {
  const child: ChildProcess = fork(runnerPath(), [], {
    execArgv: ['--experimental-strip-types', `--loader=${loaderPath()}`],
  })
  return {
    send(msg) { child.send(msg) },
    on(event, cb) { child.on(event, cb) },
    kill(signal) { child.kill(signal) },
  } as SolveChildLike
}

let childFactory: () => SolveChildLike = defaultFactory
let child: SolveChildLike | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function onMessage(msg: unknown): void {
  const m = msg as WorkerMsg
  const p = pending.get(m.id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(m.id)
  if (m.ok) {
    p.resolve(m.result ?? null)
  } else {
    p.reject(new Error(m.error ?? 'solve failed'))
  }
}

function dropChild(err: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
  if (child) {
    child.kill('SIGKILL')
    child = null
  }
}

function ensureChild(): SolveChildLike {
  if (child) return child
  const c = childFactory()
  c.on('message', onMessage)
  c.on('error', () => dropChild(new Error('solve child process crashed')))
  c.on('exit', (code: number) => {
    if (code !== 0) dropChild(new Error(`solve child exited with code ${code}`))
  })
  child = c
  return child
}

/**
 * Solve a document through solveLocally in a forked child process, guarded by
 * an OS-level timeout.
 *
 * The child loads OCC.js + the Rust sketch solver on its first request; each
 * subsequent request reuses them. Returns the BuildResponse on success, or
 * null when OCC.js is unavailable. Rejects with a timeout error when the
 * child does not respond within `timeoutMs`.
 */
export function solveWithTimeout(
  spec: Record<string, unknown>,
  options?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BuildResponse | null> {
  return new Promise<BuildResponse | null>((resolve, reject) => {
    const c = ensureChild()
    const id = nextId++
    const timer = setTimeout(() => {
      dropChild(new Error(`solve timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    c.send({ id, spec, options })
  })
}

/**
 * Terminate the pooled child. Call between test suites to get a cold start.
 */
export function disposeWorker(): void {
  dropChild(new Error('disposed'))
}

/** @internal test-only: inject a fake child factory and reset client state. */
export function setSolveChildForTest(
  factory: (() => SolveChildLike) | null,
): void {
  if (child) {
    child.kill('SIGKILL')
    child = null
  }
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  nextId = 0
  if (factory) childFactory = factory
}

/** @internal test-only: reset child factory to default (restore real fork). */
export function resetSolveChildForTest(): void {
  setSolveChildForTest(null)
  childFactory = defaultFactory
}
