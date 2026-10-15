// The wall-clock watchdog for the chain fuzz, mirroring kernel/solveTimeout.ts.
//
// An OCC call can spin forever inside synchronous WASM (the fuzz found a
// ShapeUpgrade_UnifySameDomain spin while fusing the second instance of a
// circular array, the same hazard the browser worker's 30 s watchdog exists
// for). No timer fires while that call blocks the event loop, so the recipe is
// replayed in a forked child process and SIGKILLed when it overruns.
// worker_threads terminate() cannot interrupt synchronous WASM; an OS process
// kill can.
//
// The child reports the step it is about to run before every step, so a killed
// run is reported with the step that hung, not just a timeout. The child is
// pooled across recipes (OCC loads once); a kill drops the pool and the next
// recipe forks a fresh child, exactly like solveTimeout.

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ChainRun, StalePick } from './chain'
import type { Recipe } from './recipe'

/** Minimal child-process surface used here; lets tests inject a fake. */
export interface ChainChildLike {
  send(msg: Record<string, unknown>): void
  on(event: 'message', cb: (msg: unknown) => void): void
  on(event: 'error', cb: (e: unknown) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  kill(signal?: NodeJS.Signals): void
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface HangReport {
  // The step the child was running when it was killed, or null when it hung
  // before the first step report.
  step: number | null
  kind: string | null
}

// One child replay: the chain run plus, when the chain completed clean, the
// pick re-resolution under the perturbed start (chain.runPersistenceCheck).
export interface ChainReplay {
  run: ChainRun
  stale: StalePick[]
}

export type GuardedChainRun =
  | { status: 'done'; replay: ChainReplay }
  | { status: 'hang'; hang: HangReport }

interface Pending {
  lastStep: { step: number; kind: string } | null
  resolve: (result: GuardedChainRun) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface ChildMsg {
  id: number
  ok?: boolean
  run?: ChainRun
  stale?: StalePick[]
  error?: string
  progress?: { step: number; kind: string }
}

function runnerPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'chainTimeout.runner.mjs',
  )
}

function loaderPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../resolve-alias.loader.mjs',
  )
}

function defaultFactory(): ChainChildLike {
  const child: ChildProcess = fork(runnerPath(), [], {
    execArgv: ['--experimental-strip-types', `--loader=${loaderPath()}`],
  })
  return {
    send(msg) { child.send(msg) },
    on(event, cb) { child.on(event, cb) },
    kill(signal) { child.kill(signal) },
  } as ChainChildLike
}

let childFactory: () => ChainChildLike = defaultFactory
let child: ChainChildLike | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function onMessage(msg: unknown): void {
  const m = msg as ChildMsg
  const p = pending.get(m.id)
  if (!p) return
  if (m.progress !== undefined) {
    p.lastStep = m.progress
    return
  }
  clearTimeout(p.timer)
  pending.delete(m.id)
  if (m.ok && m.run) {
    p.resolve({ status: 'done', replay: { run: m.run, stale: m.stale ?? [] } })
  } else {
    p.reject(new Error(m.error ?? 'chain replay failed'))
  }
}

/** Reject every pending recipe and drop the (possibly wedged) child. */
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

function ensureChild(): ChainChildLike {
  if (child) return child
  const c = childFactory()
  c.on('message', onMessage)
  // A killed child can deliver a late error or exit after its replacement is
  // pooled; only the current child may act on it (mirrors solveTimeout).
  c.on('error', () => {
    if (child !== c) return
    dropChild(new Error('chain child process crashed'))
  })
  c.on('exit', (code: number) => {
    if (child !== c) return
    if (code !== 0) dropChild(new Error(`chain child exited with code ${code}`))
  })
  child = c
  return child
}

/**
 * Replay one recipe through the real kernel in a forked child. Resolves with
 * the child's ChainRun, or with a HangReport when the child was killed after
 * `timeoutMs`. The timeout resolves (rather than rejects) so the sweep can
 * record the hang and keep going; the caller decides whether it is known.
 */
export function runChainWithTimeout(
  recipe: Recipe,
  options: { timeoutMs?: number } = {},
): Promise<GuardedChainRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<GuardedChainRun>((resolve, reject) => {
    const c = ensureChild()
    const id = nextId++
    const p: Pending = {
      lastStep: null,
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(id)
        const hang: HangReport = {
          step: p.lastStep?.step ?? null,
          kind: p.lastStep?.kind ?? null,
        }
        dropChild(new Error('chain child replaced after a hang'))
        resolve({ status: 'hang', hang })
      }, timeoutMs),
    }
    pending.set(id, p)
    c.send({ id, recipe })
  })
}

/** Terminate the pooled child. Call between suites so a hang cannot leak across. */
export function disposeChainChild(): void {
  dropChild(new Error('disposed'))
}

/** @internal test-only: inject a fake child factory and reset client state. */
export function setChainChildForTest(factory: (() => ChainChildLike) | null): void {
  if (child) {
    child.kill('SIGKILL')
    child = null
  }
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  nextId = 0
  if (factory) childFactory = factory
}

/** @internal test-only: reset the child factory to the real fork. */
export function resetChainChildForTest(): void {
  setChainChildForTest(null)
  childFactory = defaultFactory
}
