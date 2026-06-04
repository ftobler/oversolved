/**
 * Browser glue for phase 1 shadow mode: when enabled, solve the doc's sketches
 * with the Rust kernel alongside the Python solve and log any disagreement.
 *
 * Off by default. Enable at runtime with `localStorage.setItem('wasmShadow','1')`
 * (no rebuild). Requires the wasm-pack `--target web` build served under `/wasm/`
 * (run `npm run shadow:wasm`). Everything is wrapped so it can NEVER affect the
 * real Python solve: a missing build, a load failure, or a solver disagreement
 * only logs.
 */

import type { PartFeature } from '@/types/cad'
import { loadSolverWasm } from './solverWasm'
import { runShadow } from './shadowRunner'

const FLAG_KEY = 'wasmShadow'

function enabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Fire-and-forget shadow comparison. Safe to call unconditionally after a solve;
 * returns immediately (and does nothing) unless the flag is set and the wasm
 * loads. Never throws.
 */
export async function maybeRunShadow(
  features: PartFeature[] | undefined,
  results: Record<string, unknown>,
): Promise<void> {
  if (!enabled()) return
  try {
    const solveBytes = await loadSolverWasm()
    if (!solveBytes) return
    const report = runShadow(features, results, solveBytes)
    if (report.mismatchCount > 0) {
      const bad = report.entries.filter((e) => e.diff && !e.diff.ok)
      console.warn(`[wasm-shadow] ${report.mismatchCount}/${report.comparedCount} sketch mismatch(es):`, bad)
    } else if (report.comparedCount > 0) {
      console.info(`[wasm-shadow] ${report.comparedCount} sketch(es) match Python`)
    }
  } catch (e) {
    console.warn('[wasm-shadow] disabled (error):', e)
  }
}
