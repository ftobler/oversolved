// @vitest-environment node
//
// The real-kernel half of the split feature over the drive surface: the Ex021
// practice script in one `run` (sketch, extrude, plane, split) and the kept-side
// geometry it produces. The catalog and refusal half is splitDrive.test.ts.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'
import type { ScriptStep } from '../scriptRunner'

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
const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
const EX021_VOLUME = 500 - (Math.PI * 2.5 * 2.5 * 10) / 2
function ex021Steps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [5, 5, 2.5] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
    m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } }),
    m({ type: 'add_split', featureId: 'sp1', bodies: ['@ex1'], plane: '@pl1', keep: 'above' }),
  ]
}
describe.skipIf(!ready)('the Ex021 split script (real OCC + Rust solver)', () => {
  it('builds the holed block and keeps the top half in one run', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: ex021Steps() })
    expect(result.outcome.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    for (const step of result.outcome.steps) expect(step.ok, `${step.id}: ${step.error?.message ?? ''}`).toBe(true)
    expect(result.bodies).toEqual(['body_ex1'])

    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.measures.volume).toBeCloseTo(EX021_VOLUME, 4)
  }, 240_000)

  it('refuses a keep side it cannot name, without changing the document', async () => {
    const steps = ex021Steps()
    steps[steps.length - 1] = m({ type: 'add_split', featureId: 'sp1', bodies: ['@ex1'], plane: '@pl1', keep: 'top' })
    const result = await runHeadless({ doc: emptyDriveDoc(), steps })
    expect(result.outcome.ok).toBe(false)
    const split = result.outcome.steps[result.outcome.steps.length - 1]
    expect(split.ok).toBe(false)
    expect(split.error?.message).toContain('"both"')
  }, 240_000)
})
