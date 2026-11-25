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
import { SolveSuperseded } from '@/kernel/errors'
import { makePrng } from '@/utils/core/prng'

// `trapCount` reads how many kernel traps solveLocally has recovered from so
// far. A trap is retried on a fresh module and the retry usually passes, which
// leaves no trace in the response; a solve during which the count moved is
// reported as an error anyway, because the trap itself is the kernel bug.
//
// `verifyMeshReuse` turns on the builder's parity oracle: every body whose mesh
// a solve reused from an earlier one is tessellated afresh and compared, and a
// difference fails the solve (kernel/builderMeshReuse.ts).
//
// `abortSeed` seeds a stream (its own, so the session sequence is untouched)
// that, before about one solve in four, first runs the same solve stopped at a
// random feature boundary (`shouldAbort`). The real solve then resumes from that
// partial state, so the undo/redo sequences also run over partial caches.
export interface RealSolveSchedulerOptions {
  trapCount?: () => number
  verifyMeshReuse?: boolean
  abortSeed?: number
}

/** True at the `index`-th feature boundary of one build, false elsewhere. */
function stopAtBoundary(index: number): () => boolean {
  let boundaries = 0
  return () => boundaries++ === index
}

export function createRealSolveScheduler(options: RealSolveSchedulerOptions = {}): SolveScheduler<PartDoc> {
  let generation = 0
  let pendingCount = 0
  let lastError: string | null = null
  const idleWaiters: Array<() => void> = []
  const abortDraw = options.abortSeed === undefined ? null : makePrng(options.abortSeed)

  return {
    async request(doc, opts): Promise<SolveOutcome> {
      const requestGeneration = ++generation
      pendingCount++
      lastError = null
      let error: string | null = null
      const trapsBefore = options.trapCount?.() ?? 0
      const solveOptions = {
        bypassCache: opts?.bypassCache,
        validate: opts?.validate,
        verifyMeshReuse: options.verifyMeshReuse,
      }
      try {
        if (abortDraw && abortDraw() < 0.25) {
          const boundary = Math.floor(abortDraw() * Math.max(1, doc.features?.length ?? 0))
          try {
            // A build with fewer dirty features than `boundary` just completes.
            await solveLocally(doc as unknown as Record<string, unknown>, {
              ...solveOptions,
              shouldAbort: stopAtBoundary(boundary),
            })
          } catch (e) {
            if (!(e instanceof SolveSuperseded)) throw e
          }
        }
        const response = await solveLocally(doc as unknown as Record<string, unknown>, solveOptions)
        // The real suite is gated on OCC being loaded; a null here means the
        // loader got torn down mid-run, which is a test bug, not a solve.
        if (response === null) throw new Error('OCC.js unavailable for a real-kernel fuzz run')
        if ((options.trapCount?.() ?? 0) > trapsBefore) {
          throw new Error('kernel trap recovered by a reload; the retry passed but the trap is a kernel bug')
        }
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
