// @vitest-environment node
//
// The plan's redundancy acceptance rule, run over the frozen document corpus:
// a satisfied sketch the user accepts as clean must report zero redundant
// constraints. This is the false-positive guard for the incremental
// Gram-Schmidt walk (sketch-solver/src/solve.rs `redundancy_flags`): a walk
// that flags a real driver would dim it in the UI forever, and the corpus is
// the only large body of hand-accepted sketches available.
//
// Replays the sketch features of every regression-baseline entry through the
// real solver without OCC: corpus sketches lower through solveSketch alone
// (projections resolve from the repo, and an unresolvable one drops its
// constraint exactly as a live solve does). Skips when the node wasm package
// or the area builder is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { solveSketch, setSketchSolver, setSketchTopology, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { initGlobalRepo } from '../../query'

const solveBytes = loadSolver()
const topologyBytes = loadTopology()

interface BaselineEntry {
  label: string
  spec: { features?: Array<Record<string, unknown>> }
}

function corpusEntries(): BaselineEntry[] {
  return JSON.parse(
    readFileSync(new URL('../../../wasm-kernel/regression-baseline.json', import.meta.url), 'utf-8'),
  ) as BaselineEntry[]
}

describe.skipIf(!solveBytes || !topologyBytes)('corpus sketches report zero redundancy', () => {
  beforeAll(() => {
    setSketchSolver(solveBytes)
    setSketchTopology(topologyBytes)
  })
  afterAll(() => {
    resetSketchSolver()
    setSketchTopology(null)
  })

  it('flags no constraint on any satisfied corpus sketch', () => {
    const flagged: string[] = []
    let solved = 0
    for (const entry of corpusEntries()) {
      for (const feature of entry.spec.features ?? []) {
        if (feature.kind !== 'sketch') continue
        const out = solveSketch(feature, initGlobalRepo(), {})
        if (out.status === 'overconstrained') continue
        solved++
        for (const [cid, c] of Object.entries(out.constraints ?? {})) {
          if (c.superfluous) flagged.push(`${entry.label}/${String(feature.id)}:${cid}`)
        }
      }
    }
    // A vacuous pass (nothing solved) would defeat the guard.
    expect(solved).toBeGreaterThan(0)
    expect(flagged).toEqual([])
  })
})
