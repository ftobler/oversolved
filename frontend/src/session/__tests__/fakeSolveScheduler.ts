import type {
  SolveOptions,
  SolveOutcome,
  SolveScheduler,
  SolveSchedulerState,
} from '@/session/SolveScheduler'

// A deterministic SolveScheduler for the headless suites: nothing resolves on
// its own, so a test can line up supersession (request A, request B, flush)
// and idle ordering without racing timers. The completion order is FIFO; a
// request whose generation is no longer the newest resolves 'superseded' and
// is dropped, which is the contract the worker-backed adapter must also hold.
export interface SolveCall<Doc> {
  generation: number
  doc: Doc
  opts: SolveOptions
}

export interface FakeSolveScheduler<Doc> extends SolveScheduler<Doc> {
  readonly calls: SolveCall<Doc>[]
  // The generations whose outcome was adopted, in completion order.
  readonly appliedGenerations: number[]
  // Completes the oldest pending request; the outcome is 'applied' when it is
  // still the newest request, 'superseded' otherwise.
  flushOne(): void
  flush(): void
  // The next request to complete fails instead of applying.
  failNext(error: string): void
}

interface Pending<Doc> {
  call: SolveCall<Doc>
  resolve: (outcome: SolveOutcome) => void
}

export function createFakeSolveScheduler<Doc>(): FakeSolveScheduler<Doc> {
  const calls: SolveCall<Doc>[] = []
  const appliedGenerations: number[] = []
  const queue: Pending<Doc>[] = []
  const failureMessages: string[] = []
  const idleWaiters: Array<() => void> = []
  let generation = 0
  let lastError: string | null = null

  const drainIdle = (): void => {
    if (queue.length > 0) return
    idleWaiters.splice(0).forEach(resolve => resolve())
  }

  const completeOne = (): void => {
    const pending = queue.shift()
    if (!pending) return
    const { call } = pending
    // Supersession is decided before the result is read: a stale request's
    // failure is dropped with its success, never bannered, so a queued failure
    // stays queued for the next request that is actually adopted.
    if (call.generation !== generation) {
      pending.resolve({ generation: call.generation, status: 'superseded' })
    } else if (failureMessages.length > 0) {
      const failure = failureMessages.shift() as string
      lastError = failure
      pending.resolve({ generation: call.generation, status: 'error', error: failure })
    } else {
      appliedGenerations.push(call.generation)
      pending.resolve({ generation: call.generation, status: 'applied' })
    }
    drainIdle()
  }

  return {
    calls,
    appliedGenerations,
    request(doc, opts = {}) {
      // A new solve supersedes whatever error the last one left on the banner.
      lastError = null
      const call: SolveCall<Doc> = { generation: ++generation, doc, opts }
      calls.push(call)
      return new Promise<SolveOutcome>(resolve => { queue.push({ call, resolve }) })
    },
    idle() {
      if (queue.length === 0) return Promise.resolve()
      return new Promise<void>(resolve => { idleWaiters.push(resolve) })
    },
    state(): SolveSchedulerState {
      // The fake has no separate worker slot, so a pending request is by
      // definition the running one.
      return { generation, pending: queue.length > 0, running: queue.length > 0, lastError }
    },
    flushOne: completeOne,
    flush() {
      while (queue.length > 0) completeOne()
    },
    failNext(error) {
      failureMessages.push(error)
    },
  }
}
