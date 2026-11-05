// The headless session's scheduler wrapper: a script run defers its solves to
// the points where a caller actually needs the solved document, instead of
// paying a full tessellation and write-back after every step. The browser
// adapter keeps its immediate scheduler; only the drive run wraps one.
//
// A request records the latest document and options as the one solve owed. A
// later request replaces it, so the newest document wins and an intermediate
// one is never solved. `flush` spends the owed solve through the base scheduler
// and waits for it, which is also where `state().generation` advances: that
// count is solves, not steps. The flush API is the seam the run uses before a
// selector step (which needs solved bodies) and before a command step (registry
// code that may read the solved state), and once at the end so every reply is
// built from a settled document.

import type { SolveOptions, SolveOutcome, SolveScheduler, SolveSchedulerState } from '@/session/SolveScheduler'

export interface DeferredSolveScheduler<Doc> extends SolveScheduler<Doc> {
  // Whether a solve is owed and has not been started.
  owed(): boolean
  // Solve the latest owed document through the base scheduler and wait for it.
  // Nothing owed is a no-op, which is what keeps a refused-only script from
  // being force-solved.
  flush(): Promise<void>
}

export function createDeferredSolveScheduler<Doc>(base: SolveScheduler<Doc>): DeferredSolveScheduler<Doc> {
  let owed: { doc: Doc; opts?: SolveOptions } | null = null
  return {
    request(doc, opts): Promise<SolveOutcome> {
      // Derived data, not an edit: the session has already written the
      // document, its undo entry and its dirty flag. Only the solve waits.
      owed = opts === undefined ? { doc } : { doc, opts }
      return Promise.resolve({ generation: base.state().generation, status: 'queued' })
    },
    owed: () => owed !== null,
    async flush(): Promise<void> {
      const pending = owed
      if (pending === null) return
      // Cleared before the solve starts: a request the base scheduler makes
      // while running (there is none today) must not be spent twice.
      owed = null
      await base.request(pending.doc, pending.opts)
      await base.idle()
    },
    idle: () => base.idle(),
    state: (): SolveSchedulerState => base.state(),
  }
}
