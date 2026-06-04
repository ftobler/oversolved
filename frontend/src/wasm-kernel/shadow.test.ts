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
import { encodeInput, decodeOutput, STATUS_NAME } from './codec'
import { lowerSketch, ORIGIN_ID, type SketchInput } from './lowerSketch'

interface FeatureResult {
  status: string
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
}

interface RegressionEntry {
  label: string
  input_sketches?: SketchInput[]
  result: Record<string, FeatureResult>
}

const entries = baseline as unknown as RegressionEntry[]
const solve = loadSolver()

const cases: Array<{ label: string; sketch: SketchInput; result: FeatureResult }> = []
for (const entry of entries) {
  for (const sketch of entry.input_sketches ?? []) {
    const result = entry.result[sketch.id]
    if (result) cases.push({ label: `${entry.label}/${sketch.id}`, sketch, result })
  }
}

/** A param is gauge-free (worth comparing) when the entity is determinate, or
 * when Python left it at its seed (then both solvers stay there). */
function close(a: number[], b: number[], tol: number): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => Math.abs(v - b[i]) <= tol)
}

describe.skipIf(!solve)('phase 1 shadow-mode parity (Rust vs Python)', () => {
  it('the baseline carries sketch inputs', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$label', ({ sketch, result }) => {
    const { input, layout } = lowerSketch(sketch)
    const out = decodeOutput(solve!(encodeInput(input)))

    // The Rust solve is feasible (lands on the constraint manifold).
    expect(out.diagnostics.residualNorm).toBeLessThan(1e-4)

    // Overall status parity.
    expect(STATUS_NAME[out.overallStatus]).toBe(result.status)

    const geometry = result.geometry ?? {}
    const features = result.features ?? {}

    layout.forEach((ent, index) => {
      if (ent.id === ORIGIN_ID) return
      const pyStatus = features[ent.id]?.status
      const pyParams = geometry[ent.id]
      if (!pyStatus || !pyParams) return

      // Per-entity status parity.
      expect(STATUS_NAME[out.entityStatus[index]], `status of ${ent.id}`).toBe(pyStatus)

      // Geometry parity only where the point is gauge-free: either Python marks
      // the entity fully_constrained, or it never moved it off the seed.
      const seed = sketch.initial[ent.id] ?? new Array(ent.size).fill(0)
      const determinate = pyStatus === 'fully_constrained' || close(pyParams, seed, 1e-6)
      if (determinate) {
        const rust = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
        expect(close(rust, pyParams, 1e-3), `geometry of ${ent.id}: rust=${rust} py=${pyParams}`).toBe(true)
      }
    })
  })
})
