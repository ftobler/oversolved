/**
 * Phase 1 shadow-mode parity: run the Rust solver against every sketch in the
 * Python-generated regression baseline and diff status + geometry. The baseline
 * (`regression-baseline.json`, produced by `tests/wasm_harness/extract_fixtures.py`)
 * is canonical; this never feeds Rust's output downstream. See the migration
 * plan's "Phase 1" exit criterion.
 *
 * Skips entirely (not fails) when the wasm-pack build is absent, so a fresh
 * checkout's `just frontend` stays green. Build it with:
 *   cd sketch-solver && wasm-pack build --target nodejs --out-dir pkg-node --release
 */

import { describe, it, expect } from 'vitest'
import baseline from './regression-baseline.json'
import { loadSolver } from './loadSolver'
import { compareSketch, type PythonSketchResult } from './shadowCompare'
import { type SketchInput } from './lowerSketch'

interface RegressionEntry {
  label: string
  input_sketches?: SketchInput[]
  result: Record<string, PythonSketchResult>
}

const entries = baseline as unknown as RegressionEntry[]
const solve = loadSolver()

const cases: Array<{ label: string; sketch: SketchInput; result: PythonSketchResult }> = []
for (const entry of entries) {
  if ((entry as Record<string, unknown>).soft) continue
  for (const sketch of entry.input_sketches ?? []) {
    const result = entry.result[sketch.id]
    if (result) cases.push({ label: `${entry.label}/${sketch.id}`, sketch, result })
  }
}

describe.skipIf(!solve)('phase 1 shadow-mode parity (Rust vs Python)', () => {
  it('the baseline carries sketch inputs', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$label', ({ sketch, result }) => {
    const diff = compareSketch(sketch, result, solve!)
    // A readable failure: dump the structured diff when parity breaks.
    expect(diff, JSON.stringify(diff, null, 2)).toMatchObject({ ok: true })
  })

  it('reports a mismatch when the Python result disagrees', () => {
    const { sketch, result } = cases[0]
    const flipped = result.status === 'fully_constrained' ? 'overconstrained' : 'fully_constrained'
    const diff = compareSketch(sketch, { ...result, status: flipped }, solve!)
    expect(diff.ok).toBe(false)
    expect(diff.statusMatch).toBe(false)
    // It still reports the true Rust status and feasibility alongside the diff.
    expect(diff.feasible).toBe(true)
  })
})
