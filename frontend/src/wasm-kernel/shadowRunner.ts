/**
 * Phase 1 in-app shadow runner: solve each lowerable sketch of a PartDoc with
 * the Rust kernel and diff against the canonical Python result. Pure and
 * loader-agnostic (the wasm entry is injected), so it is fully unit-testable;
 * `shadowMode.maybeRunShadow` is the thin browser glue that loads the wasm and
 * calls this.
 *
 * Per the plan, Python stays canonical: this only produces diffs to log, it
 * never feeds the downstream build.
 */

import type { PartFeature } from '@/types/cad'
import { partDocToSketches } from './partDocToSketches'
import { compareSketch, type PythonSketchResult, type ShadowDiff, type SolveBytes } from './shadowCompare'

export interface ShadowEntry {
  featureId: string
  diff?: ShadowDiff
  skipped?: string
  error?: string
}

export interface ShadowReport {
  entries: ShadowEntry[]
  comparedCount: number
  mismatchCount: number
}

function isPythonSketchResult(v: unknown): v is PythonSketchResult {
  return typeof v === 'object' && v !== null && typeof (v as { status?: unknown }).status === 'string'
}

/**
 * Run the shadow comparison for every lowerable sketch. `results` is the
 * Python `BuildResponse.result` map (feature id -> per-feature result).
 */
export function runShadow(
  features: PartFeature[] | undefined,
  results: Record<string, unknown>,
  solveBytes: SolveBytes,
): ShadowReport {
  const { sketches, skipped } = partDocToSketches(features)
  const entries: ShadowEntry[] = []
  let comparedCount = 0
  let mismatchCount = 0

  for (const skip of skipped) {
    entries.push({ featureId: skip.featureId, skipped: skip.reason })
  }

  for (const { featureId, sketch } of sketches) {
    const pyResult = results[featureId]
    if (!isPythonSketchResult(pyResult)) {
      entries.push({ featureId, skipped: 'no python sketch result' })
      continue
    }
    try {
      const diff = compareSketch(sketch, pyResult, solveBytes)
      comparedCount += 1
      if (!diff.ok) mismatchCount += 1
      entries.push({ featureId, diff })
    } catch (e) {
      entries.push({ featureId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { entries, comparedCount, mismatchCount }
}
