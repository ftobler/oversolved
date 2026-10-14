// A fuzz-only SolveScheduler over the production headless solve entry
// solveLocally, mirroring createWorkerSolveScheduler's supersession contract
// without the worker: generation bumps on every request, a request a newer one
// overtook resolves 'superseded', and a throw out of the kernel is reported as
// an 'error' outcome rather than rejection. It forwards only the SolveOptions
// solveLocally actually takes (bypassCache, validate); the session's
// drag-family hints (_suppressFirstSolve, dragAnchor) and _restoreSolveResults
// are worker-adapter concerns with no headless equivalent, so they are
// deliberately dropped rather than mapped to something with other semantics.
// The caller must install the node OCC loader and Rust solver before use
// (setSolveLocalsForTest + setSketchSolver), exactly as the other real suites.
import type { PartDoc } from '@/types/cad'
import type { SolveOutcome, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'
import { solveLocally } from '@/kernel/solveLocally'

export function createRealSolveScheduler(): SolveScheduler<PartDoc> {
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
        const response = await solveLocally(doc as unknown as Record<string, unknown>, {
          bypassCache: opts?.bypassCache,
          validate: opts?.validate,
        })
        // The real suite is gated on OCC being loaded; a null here means the
        // loader got torn down mid-run, which is a test bug, not a solve.
        if (response === null) throw new Error('OCC.js unavailable for a real-kernel fuzz run')
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
      return { generation, pending: pendingCount > 0, running: pendingCount > 0, lastError }
    },
  }
}
