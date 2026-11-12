/**
 * The MCP server's kernel host: the solve runs in a worker thread so a kernel
 * operation that never returns costs one call, not the server (bug-fuse-hang).
 *
 * The stdio loop awaits each call, and a solve is one synchronous WASM-backed
 * stretch that nothing in its own thread can interrupt. In a worker it can be:
 * `Worker.terminate()` stops a thread spinning inside OCC's WASM (V8 checks for
 * termination in WASM loops; measured at ~150 ms on Node 24). The host keeps
 * one worker, posts one call at a time, and arms a stall budget that every
 * feature progress mark (featureProgress.ts) re-arms. When it runs out the
 * host terminates the worker, rejects the call with a KernelTimeout naming the
 * last feature, and the next call spawns a fresh worker. The worker loses only
 * its checkpoint cache; documents live with the server (the docHash store).
 * The worker also posts the state each settled step left, so the timeout
 * rejection carries the accepted prefix when there is one; it is stored on the
 * in-flight call and dies with it, so a later call can never read a stale one.
 *
 * A worker reply can also fault: a WASM trap that escaped the kernel answers
 * with a KernelFault, and if its modules could not be replaced in that thread
 * the reply says so (`reloaded: false`). The host then drops the worker like a
 * stall does, so the next call gets fresh modules even when a module gains a
 * reload flaw the in-worker recovery cannot handle (bug-headless-sketch-trap-reload).
 *
 * The worker side is kernelWorker.ts; this module never loads the kernel.
 */

import { solveTimeoutMessage } from '@/kernel/featureProgress'
import { SOLVE_STALL_BUDGET_MS } from '@/kernel/solverConstants'
import type { HeadlessCheckpoint } from '@/drive/headlessPart'

/** The kernel operations a worker serves (kernelWorker.ts). */
export type KernelOp = 'run' | 'measure' | 'compare' | 'export' | 'select' | 'assemblyRun' | 'assemblyMeasure' | 'assemblyCompare' | 'assemblyExport'

export interface KernelRequest {
  id: number
  op: KernelOp
  args: unknown
}

/** A kernel error carried across the thread boundary by name and message. */
export interface KernelErrorShape {
  name: string
  message: string
  /** KernelFault only: whether recovery already replaced the trapped modules.
   *  A missing flag is read as recovered, so an old shape keeps the worker. */
  reloaded?: boolean
}

/** A KernelFault revived from a worker reply: its name, message and the flag
 *  that decides whether this thread can serve the next call. */
export interface RevivedKernelFault extends Error {
  name: 'KernelFault'
  reloaded: boolean
}

/** True for a fault whose worker-thread modules were NOT replaced. The host
 *  drops such a worker; this reads the carried flag, never the message. */
export function isUnrecoveredKernelFault(e: unknown): e is RevivedKernelFault {
  return e instanceof Error && e.name === 'KernelFault'
    && (e as { reloaded?: unknown }).reloaded === false
}

/**
 * The tool error text for a failed kernel call. A KernelFault is answered on a
 * kernel that is live again (the modules were reloaded, or the host dropped the
 * worker that could not reload them), so say what the caller's next call gets;
 * the bare fault text reads like the server is wedged for good, which is what
 * the headless trap report complained about (bug-headless-sketch-trap-reload).
 */
export function kernelToolErrorMessage(e: Error): string {
  if (e.name !== 'KernelFault') return e.message
  return `${e.message}; the next call runs on a fresh kernel`
}

/** The kernel state a successful reply can carry. A `run` reports its trap on
 *  `solve.lastError`, so only the recovery outcome is needed beside the value. */
export interface KernelFaultState {
  name: 'KernelFault'
  reloaded: boolean
}

/** Everything a kernel worker posts: a feature mark, the state a settled step
 *  left (the stall answer), or the reply to a call. A successful reply can
 *  still carry `fault` when the kernel state it produced is dead: a `run`
 *  reports its trap as `solve.lastError`, not as a thrown error, so the worker
 *  names the state beside the value the caller still needs. */
export type KernelHostMessage =
  | { kind: 'progress'; featureId: string }
  | ({ kind: 'checkpoint'; id: number } & HeadlessCheckpoint)
  | { kind: 'reply'; id: number; ok: true; value: unknown; fault?: KernelFaultState }
  | { kind: 'reply'; id: number; ok: false; error: KernelErrorShape }

/** The node `Worker` surface the host uses; tests inject a fake. */
export interface KernelWorkerLike {
  postMessage(msg: KernelRequest): void
  on(event: 'message', cb: (msg: KernelHostMessage) => void): void
  on(event: 'error', cb: (e: Error) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  terminate(): Promise<number> | void
}

/** The host gave up on a call whose solve stopped announcing features. The
 *  checkpoint is the state the last settled step left, null when the call
 *  stalled in its first solve and never had one. */
export class KernelTimeout extends Error {
  override name = 'KernelTimeout'
  readonly checkpoint: HeadlessCheckpoint | null

  constructor(message: string, checkpoint: HeadlessCheckpoint | null = null) {
    super(message)
    this.checkpoint = checkpoint
  }
}

/** The worker died under a call (a crash or an exit); the next call respawns. */
export class KernelWorkerLost extends Error {
  override name = 'KernelWorkerLost'
}

/**
 * The failures a server reports as a tool error (`ok: false` with the
 * message) rather than an internal error. A timeout, a lost worker or a trap
 * leaves the next call a working kernel, and an ExportSelectionError is the
 * caller's own bad body id: all of them are tool failures rather than bugs.
 */
export function isKernelCallFailure(e: unknown): e is Error {
  return e instanceof Error
    && (
      e.name === 'KernelTimeout'
      || e.name === 'KernelWorkerLost'
      || e.name === 'KernelFault'
      || e.name === 'ExportSelectionError'
    )
}

export interface KernelHost {
  // Run one kernel op; calls queue behind each other in arrival order.
  call(op: KernelOp, args: unknown): Promise<unknown>
  // Terminate the worker (server shutdown, test teardown).
  dispose(): Promise<void>
}

export interface KernelHostOptions {
  factory: () => KernelWorkerLike
  budgetMs?: number
}

interface InFlight {
  id: number
  resolve: (value: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
  lastFeatureId: string | null
  // The assembly bundle mark (`part <doc_id>`) that owns the feature marks.
  lastPartId: string | null
  // The latest state a settled step posted, for the stall rejection. It dies
  // with the call: a new call starts with none.
  checkpoint: HeadlessCheckpoint | null
}

function reviveError(shape: KernelErrorShape): Error {
  const e = new Error(shape.message)
  // The name is the contract the server reads (a KernelFault is a tool error
  // with a readable reason): keep it, the class cannot cross the thread. The
  // reload flag rides along for the same reason: the host must respawn without
  // matching message text.
  e.name = shape.name
  if (shape.name === 'KernelFault') {
    (e as RevivedKernelFault).reloaded = shape.reloaded ?? true
  }
  return e
}

export function createKernelHost(opts: KernelHostOptions): KernelHost {
  const budgetMs = opts.budgetMs ?? SOLVE_STALL_BUDGET_MS
  let worker: KernelWorkerLike | null = null
  let inFlight: InFlight | null = null
  let nextId = 1
  // The tail of the call queue: each call starts once the previous settled.
  let tail: Promise<unknown> = Promise.resolve()

  const drop = (w: KernelWorkerLike): void => {
    if (worker === w) worker = null
    // A terminate failure has nothing left to recover; the reference is gone.
    void Promise.resolve(w.terminate()).catch(() => {})
  }

  const settle = (fn: (p: InFlight) => void): void => {
    const p = inFlight
    if (!p) return
    inFlight = null
    clearTimeout(p.timer)
    fn(p)
  }

  const onStall = (): void => {
    const w = worker
    const checkpoint = inFlight?.checkpoint ?? null
    settle(p => p.reject(new KernelTimeout(solveTimeoutMessage(budgetMs, p.lastFeatureId, p.lastPartId), checkpoint)))
    if (w) drop(w)
  }

  const ensureWorker = (): KernelWorkerLike => {
    if (worker) return worker
    const w = opts.factory()
    w.on('message', (msg) => {
      // A late message from a worker already dropped must not touch the
      // call its replacement is serving.
      if (worker !== w) return
      if (msg.kind === 'progress') {
        const p = inFlight
        if (!p) return
        if (msg.featureId.startsWith('part ')) p.lastPartId = msg.featureId
        else p.lastFeatureId = msg.featureId
        clearTimeout(p.timer)
        p.timer = setTimeout(onStall, budgetMs)
        return
      }
      if (msg.kind === 'checkpoint') {
        const p = inFlight
        if (!p || p.id !== msg.id) return
        p.checkpoint = {
          doc: msg.doc,
          bodies: msg.bodies,
          solve: msg.solve,
          steps: msg.steps,
        }
        return
      }
      if (inFlight?.id !== msg.id) return
      if (msg.ok) {
        settle((p) => p.resolve(msg.value))
        // A value-level fault never crosses as an error reply: a `run` keeps
        // its checkpoint and step outcomes and names the trap on
        // `solve.lastError`. The worker reports the kernel state beside it, and
        // that decides the same respawn.
        if (msg.fault !== undefined && !msg.fault.reloaded) drop(w)
        return
      }
      const error = reviveError(msg.error)
      settle((p) => p.reject(error))
      // A fault whose modules could not be replaced leaves this thread's kernel
      // dead. A fresh thread loads fresh modules, so the next call can never
      // post into the poisoned one; a recovered fault keeps the worker, whose
      // other modules are still warm.
      if (isUnrecoveredKernelFault(error)) drop(w)
    })
    w.on('error', (e) => {
      if (worker !== w) return
      settle((p) => p.reject(new KernelWorkerLost(`kernel worker crashed: ${e.message}`)))
      drop(w)
    })
    w.on('exit', (code) => {
      if (worker !== w) return
      worker = null
      settle((p) => p.reject(new KernelWorkerLost(`kernel worker exited with code ${code}`)))
    })
    worker = w
    return w
  }

  let disposed = false

  const start = (op: KernelOp, args: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('kernel host disposed'))
        return
      }
      const id = nextId++
      // Armed before the post, so the kernel load at a fresh worker's first
      // call counts against the budget too: a load that never finishes is a
      // stall like any other.
      inFlight = { id, resolve, reject, timer: setTimeout(onStall, budgetMs), lastFeatureId: null, lastPartId: null, checkpoint: null }
      try {
        ensureWorker().postMessage({ id, op, args })
      } catch (e) {
        // A spawn failure is the same fault as a worker that dies: a tool
        // error, like the asynchronous 'error' event.
        const reason = e instanceof Error ? e.message : String(e)
        settle((p) => p.reject(new KernelWorkerLost(`kernel worker failed to start: ${reason}`)))
      }
    })

  return {
    call(op, args) {
      const run = tail.then(() => start(op, args))
      // The queue continues past a failed call; the caller still sees it fail.
      tail = run.catch(() => {})
      return run
    },
    async dispose() {
      const w = worker
      disposed = true
      settle((p) => p.reject(new Error('kernel host disposed')))
      worker = null
      if (w) await Promise.resolve(w.terminate())
    },
  }
}
