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
// run is reported with the step that hung, not just a timeout. The pool is
// bounded: ROBUSTNESS_FUZZ_WORKERS recipes replay concurrently, one per child.
// A kill drops that child alone; sibling children and their in-flight recipes
// are untouched.
//
// Every child replays exactly one recipe and is then retired, so each seed
// starts on a freshly loaded kernel. A reused child carried OCC state from the
// recipes before it, and that state flipped borderline fuses, fillets and
// persistence picks: identical 1500-seed sweeps disagreed on dozens of seeds,
// and a seed that spins in a fresh child (762) finished in a warm one. The
// fresh load costs ~1.5 s per recipe against ~0.12 s for a warm replay; that
// buys a sweep whose findings are a function of the seed alone. The default
// pool is small because each child holds its own OCC kernel (~0.75 GB
// measured), which the vitest memory budget counts once per fork, not once
// per child.
//
// Requests beyond the pool size wait in a FIFO queue, and a queued recipe's
// timeout clock starts when a child picks it up: queueing can never burn the
// recipe's budget, and a full pool looks like latency, not a hang. The fresh
// child's kernel load does count against it (~1.5 s of the 30 s).

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

// The pool size: more than one child for throughput, few enough that the
// kernels stay inside the runner's memory. The sweep reads the knob
// (ROBUSTNESS_FUZZ_WORKERS) in its test file and configures the pool here; the
// justfile pins both the pool and the vitest forks on the memory bounded CI
// runners, and a wide x86 box can raise the pool.
const DEFAULT_WORKERS = 2
let maxWorkers = DEFAULT_WORKERS

/** Bound the pool; call before the first replay. */
export function configureChainWorkers(workers: number): void {
  maxWorkers = Number.isFinite(workers) ? Math.max(1, Math.floor(workers)) : DEFAULT_WORKERS
}

/** The pool size; the sweep scales its own timeout budget by it. */
export function chainWorkerCount(): number {
  return maxWorkers
}

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

// One queued or in-flight recipe. The watchdog timer is created at dispatch,
// not at enqueue, so waiting for a free child cannot expire it.
interface Job {
  recipe: Recipe
  timeoutMs: number
  resolve: (result: GuardedChainRun) => void
  reject: (err: unknown) => void
}

interface Pending {
  id: number
  job: Job
  lastStep: { step: number; kind: string } | null
  timer: ReturnType<typeof setTimeout>
}

// A forked child and the one recipe it is running. `dead` is set the moment
// the slot leaves the pool, so late messages, errors or exits from a killed
// child are ignored instead of being attributed to a replacement.
interface Slot {
  child: ChainChildLike
  pending: Pending | null
  dead: boolean
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
const slots: Slot[] = []
const queue: Job[] = []
let nextId = 0

function onMessage(slot: Slot, msg: unknown): void {
  if (slot.dead) return
  const p = slot.pending
  if (!p) return
  const m = msg as ChildMsg
  if (m.id !== p.id) return
  if (m.progress !== undefined) {
    p.lastStep = m.progress
    return
  }
  clearTimeout(p.timer)
  slot.pending = null
  if (m.ok && m.run) {
    p.job.resolve({ status: 'done', replay: { run: m.run, stale: m.stale ?? [] } })
  } else {
    p.job.reject(new Error(m.error ?? 'chain replay failed'))
  }
  // One recipe per kernel: retire the child (nothing is pending, so nothing
  // is rejected) and let the pump start the next recipe on a fresh one.
  removeSlot(slot, new Error('chain child retired'))
  pump()
}

/** Take the slot out of the pool, kill it, and reject whatever it was running. */
function removeSlot(slot: Slot, err: Error): void {
  if (slot.dead) return
  slot.dead = true
  const at = slots.indexOf(slot)
  if (at >= 0) slots.splice(at, 1)
  const p = slot.pending
  if (p) {
    clearTimeout(p.timer)
    slot.pending = null
    p.job.reject(err)
  }
  slot.child.kill('SIGKILL')
}

function dispatch(slot: Slot, job: Job): void {
  const id = nextId++
  const p: Pending = {
    id,
    job,
    lastStep: null,
    timer: setTimeout(() => onTimeout(slot), job.timeoutMs),
  }
  slot.pending = p
  slot.child.send({ id, recipe: job.recipe })
}

function onTimeout(slot: Slot): void {
  const p = slot.pending
  if (p === null) return
  const hang: HangReport = {
    step: p.lastStep?.step ?? null,
    kind: p.lastStep?.kind ?? null,
  }
  // The recipe is settled as a hang, not an error: detach it before the slot
  // is removed so the removal does not reject it, then kill the child (it
  // cannot be trusted to answer again) and settle.
  slot.pending = null
  removeSlot(slot, new Error('chain child replaced after a hang'))
  p.job.resolve({ status: 'hang', hang })
  pump()
}

function spawnSlot(): Slot {
  const child = childFactory()
  const slot: Slot = { child, pending: null, dead: false }
  child.on('message', (msg) => onMessage(slot, msg))
  // A killed child can deliver a late error or exit; the guards in `onMessage`
  // and here keep it from touching the replacement that took its place. A
  // crash also frees the slot's capacity, so a queued recipe must be picked up
  // by a fresh child (the timeout path pumps for the same reason); the dead
  // check keeps a kill this module performed from re-pumping.
  child.on('error', () => {
    if (slot.dead) return
    removeSlot(slot, new Error('chain child process crashed'))
    pump()
  })
  child.on('exit', (code: number) => {
    if (slot.dead) return
    removeSlot(slot, new Error(`chain child exited with code ${code}`))
    pump()
  })
  slots.push(slot)
  return slot
}

/** Start queued recipes on freshly spawned slots, up to the bound. */
function pump(): void {
  while (queue.length > 0 && slots.length < maxWorkers) {
    dispatch(spawnSlot(), queue.shift() as Job)
  }
}

/**
 * Replay one recipe through the real kernel in its own forked child. Resolves
 * with the child's ChainRun, or with a HangReport when the child was killed
 * after `timeoutMs`. The timeout resolves (rather than rejects) so the sweep
 * can record the hang and keep going; the caller decides whether it is known.
 */
export function runChainWithTimeout(
  recipe: Recipe,
  options: { timeoutMs?: number } = {},
): Promise<GuardedChainRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<GuardedChainRun>((resolve, reject) => {
    queue.push({ recipe, timeoutMs, resolve, reject })
    pump()
  })
}

/** Terminate every pooled child. Call between suites so a hang cannot leak across. */
export function disposeChainChild(): void {
  for (const slot of [...slots]) removeSlot(slot, new Error('disposed'))
  for (const job of queue.splice(0)) job.reject(new Error('disposed'))
}

/** @internal test-only: inject a fake child factory and reset client state. */
export function setChainChildForTest(factory: (() => ChainChildLike) | null): void {
  for (const slot of [...slots]) removeSlot(slot, new Error('reset'))
  for (const job of queue.splice(0)) job.reject(new Error('reset'))
  nextId = 0
  if (factory) childFactory = factory
}

/** @internal test-only: reset the child factory to the real fork. */
export function resetChainChildForTest(): void {
  setChainChildForTest(null)
  childFactory = defaultFactory
  maxWorkers = DEFAULT_WORKERS
}
