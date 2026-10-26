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
 *
 * The worker side is kernelWorker.ts; this module never loads the kernel.
 */

import { solveTimeoutMessage } from '@/kernel/featureProgress'
import { SOLVE_STALL_BUDGET_MS } from '@/kernel/solverConstants'

/** The kernel operations a worker serves (kernelWorker.ts). */
export type KernelOp = 'run' | 'measure' | 'compare' | 'export' | 'select'

export interface KernelRequest {
  id: number
  op: KernelOp
  args: unknown
}

/** A kernel error carried across the thread boundary by name and message. */
export interface KernelErrorShape {
  name: string
  message: string
}

/** Everything a kernel worker posts: a feature mark or the reply to a call. */
export type KernelHostMessage =
  | { kind: 'progress'; featureId: string }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: KernelErrorShape }

/** The node `Worker` surface the host uses; tests inject a fake. */
export interface KernelWorkerLike {
  postMessage(msg: KernelRequest): void
  on(event: 'message', cb: (msg: KernelHostMessage) => void): void
  on(event: 'error', cb: (e: Error) => void): void
  on(event: 'exit', cb: (code: number) => void): void
  terminate(): Promise<number> | void
}

/** The host gave up on a call whose solve stopped announcing features. */
export class KernelTimeout extends Error {
  override name = 'KernelTimeout'
}

/** The worker died under a call (a crash or an exit); the next call respawns. */
export class KernelWorkerLost extends Error {
  override name = 'KernelWorkerLost'
}

/**
 * The failures a server reports as a tool error (`ok: false` with the
 * message) rather than an internal error: the kernel itself failed the call,
 * and the next call gets a working kernel again.
 */
export function isKernelCallFailure(e: unknown): e is Error {
  return e instanceof Error
    && (e.name === 'KernelTimeout' || e.name === 'KernelWorkerLost' || e.name === 'KernelFault')
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
}

function reviveError(shape: KernelErrorShape): Error {
  const e = new Error(shape.message)
  // The name is the contract the server reads (a KernelFault is a tool error
  // with a readable reason): keep it, the class cannot cross the thread.
  e.name = shape.name
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
    settle((p) => p.reject(new KernelTimeout(solveTimeoutMessage(budgetMs, p.lastFeatureId))))
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
        p.lastFeatureId = msg.featureId
        clearTimeout(p.timer)
        p.timer = setTimeout(onStall, budgetMs)
        return
      }
      if (inFlight?.id !== msg.id) return
      if (msg.ok) settle((p) => p.resolve(msg.value))
      else settle((p) => p.reject(reviveError(msg.error)))
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
      inFlight = { id, resolve, reject, timer: setTimeout(onStall, budgetMs), lastFeatureId: null }
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
