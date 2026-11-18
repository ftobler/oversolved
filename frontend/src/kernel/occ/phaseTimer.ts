/**
 * Opt-in wall-clock accounting for the kernel's import and render phases.
 *
 * Off by default: `timePhase` is then one null check around the call, so the
 * call sites can stay in the production path. A bench
 * (src/kernel/__tests__/stepImportBenchReal.test.ts) or a profiling session turns it on, runs a solve, and reads back how long each
 * named phase took in total and how often it ran. The point is to measure the
 * real pipeline, not a copy of it that drifts.
 *
 * Phases nest freely; a nested phase's time is also inside its parent's, so the
 * totals are per name, not a partition.
 */

export interface PhaseTotal {
  ms: number
  calls: number
}

let sink: Map<string, PhaseTotal> | null = null

/** Start collecting; drops whatever an earlier run left. */
export function startPhaseTiming(): void {
  sink = new Map()
}

/** Stop collecting and hand back the totals, in first-seen order. */
export function stopPhaseTiming(): Map<string, PhaseTotal> {
  const out = sink ?? new Map<string, PhaseTotal>()
  sink = null
  return out
}

/** Run `fn`, charging its wall time to `name` while timing is on. */
export function timePhase<T>(name: string, fn: () => T): T {
  if (sink === null) return fn()
  const start = performance.now()
  try {
    return fn()
  } finally {
    // Read the sink again: a phase that stops timing inside itself must not
    // write into a map nobody holds any more.
    if (sink !== null) {
      const total = sink.get(name) ?? { ms: 0, calls: 0 }
      total.ms += performance.now() - start
      total.calls += 1
      sink.set(name, total)
    }
  }
}
