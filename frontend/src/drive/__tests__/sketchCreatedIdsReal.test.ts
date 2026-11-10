// @vitest-environment node
//
// The Ex022 shape: a rectangle authors its own line ids, so a revolve in the
// same `run` names `@sk1/l` without a read-back between the steps. Real kernel,
// gated like the other drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

describe.skipIf(!ready)('sketch created ids chain a run (real OCC + Rust solver)', () => {
  it('add_rect authors the four side ids and the same run revolves about one', async () => {
    const steps: ScriptStep[] = [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      {
        mutation: {
          type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10],
          entityIds: ['b', 'r', 't', 'l'],
        },
      },
      {
        mutation: {
          type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 360, axis: '@sk1/l',
        },
      },
    ]
    const result = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.outcome.steps[1].createdIds).toEqual(['b', 'r', 't', 'l'])
    expect(result.outcome.steps[1].constraints).toBe(8)
    expect(result.part.solveOutcomes().rev1.status).toBe('ok')

    // The 10 x 10 section revolving a full turn about its left edge is a
    // cylinder of radius 10 and height 10.
    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.volume).toBeCloseTo(Math.PI * 10 * 10 * 10, 3)
  }, 120_000)
})
