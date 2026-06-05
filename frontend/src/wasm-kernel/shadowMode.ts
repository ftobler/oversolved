/**
 * Browser glue for phase 1 shadow mode: solve the doc's sketches with the
 * Rust kernel alongside the Python solve and log any disagreement.
 *
 * Always-on (phase 2g shipped). Requires the wasm-pack `--target web` build
 * served under `/wasm/` (run `npm run shadow:wasm`). Everything is wrapped so
 * it can NEVER affect the real Python solve: a missing build, a load failure,
 * or a solver disagreement only logs.
 */

import type { PartFeature } from '@/types/cad'
import { loadSolverWasm } from './solverWasm'
import { runShadow } from './shadowRunner'

/**
 * Fire-and-forget shadow comparison. Safe to call unconditionally after a solve;
 * returns immediately (and does nothing) when the wasm is unavailable. Never throws.
 */
export async function maybeRunShadow(
  features: PartFeature[] | undefined,
  results: Record<string, unknown>,
): Promise<void> {
  try {
    const solveBytes = await loadSolverWasm()
    if (!solveBytes) return
    const report = runShadow(features, results, solveBytes)
    if (report.mismatchCount > 0) {
      const bad = report.entries.filter((e) => e.diff && !e.diff.ok)
      console.warn(`[wasm-shadow] ${report.mismatchCount}/${report.comparedCount} sketch mismatch(es):`, bad)
    } else if (report.comparedCount > 0) {
      console.debug(`[wasm-shadow] ${report.comparedCount} sketch(es) match Python`)
    }
    if (report.entries.some((e) => e.skipped)) {
      const skipReasons = report.entries.filter((e) => e.skipped).map((e) => `${e.featureId}: ${e.skipped}`)
      console.debug('[wasm-shadow] skipped sketches:', skipReasons)
    }
  } catch {
    // Shadow mode is fire-and-forget; a load error (no wasm served) is normal.
  }
}
