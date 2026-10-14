import type { PartDoc } from '@/types/cad'
import type { SolveOptions, SolveOutcome, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'

export type ReSolveFn = (doc: PartDoc, opts?: SolveOptions) => Promise<void> | void

// The worker-backed SolveScheduler: every request bumps a generation and calls
// the existing reSolve plumbing. Supersession lives here, not in the callers:
// useSolver already drops a stale response by request id, and a request a newer
// one has overtaken when it settles resolves 'superseded' rather than being
// mistaken for the current result. reSolve reports failures through its own
// state, so the outcome is 'error' only for a thrown one. The getter defers the
// ref read to request time, so the scheduler can be built during render.
export function createWorkerSolveScheduler(getReSolve: () => ReSolveFn | null): SolveScheduler<PartDoc> {
  let generation = 0
  let pendingCount = 0
  let lastError: string | null = null
  const idleWaiters: Array<() => void> = []

  return {
    async request(doc, opts): Promise<SolveOutcome> {
      const requestGeneration = ++generation
      pendingCount++
      lastError = null
      let error: string | null = null
      try {
        // Keep the one-argument call shape for an optionless request: the
        // existing solver suites pin reSolve(doc) exactly.
        if (opts === undefined) await getReSolve()?.(doc)
        else await getReSolve()?.(doc, opts)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        pendingCount--
        if (pendingCount === 0) idleWaiters.splice(0).forEach(resolve => resolve())
      }
      if (error !== null) {
        lastError = error
        return { generation: requestGeneration, status: 'error', error }
      }
      if (requestGeneration !== generation) {
        return { generation: requestGeneration, status: 'superseded' }
      }
      return { generation: requestGeneration, status: 'applied' }
    },
    idle(): Promise<void> {
      if (pendingCount === 0) return Promise.resolve()
      return new Promise<void>(resolve => { idleWaiters.push(resolve) })
    },
    state(): SolveSchedulerState {
      // One worker: a pending request is the running one.
      return { generation, pending: pendingCount > 0, running: pendingCount > 0, lastError }
    },
  }
}
