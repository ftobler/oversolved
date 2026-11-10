// @vitest-environment node
//
// End-to-end drive for a fit spline whose end the area builder merged onto an
// arc end 5e-7 outside the arc's circle. The sketch is the smallest shape that
// exposes the bug: a bottom line, the right half of a tip circle, and a flank
// spline leaving that circle. Before the terminal poles followed the merged
// joints, makeWire dropped the spline and the extrude failed with "only 2 of 3
// edges connected". Skips when OCC or the solver is absent.
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

/** The minimal tooth: bottom line, right half of the tip circle, flank spline. */
function toothSteps(flankParams: number[]): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10, 0], entityId: 'bottom' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [10, 5, 5, -90, 90], entityId: 'tip' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'fit_spline', params: flankParams, entityId: 'flank' } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' } },
  ]
}

async function build(flankParams: number[]) {
  const built = await runHeadless({ doc: emptyDriveDoc(), steps: toothSteps(flankParams) })
  expect(nonSketchProblems(built.features)).toEqual([])
  expect(built.bodies).toHaveLength(1)
  return { built, volume: (await measureHeadless(built.doc!))!.measures.volume }
}

describe.skipIf(!ready)('merged fit-spline joint (real kernel)', () => {
  it('builds an extruded tooth whose spline starts 5e-7 outside the tip arc', async () => {
    const merged = await build([10, 10.0000005, 5, 8, 0, 0])
    const exact = await build([10, 10, 5, 8, 0, 0])
    expect(Math.abs(merged.volume - exact.volume)).toBeLessThanOrEqual(Math.abs(exact.volume) * 1e-6)
  }, 120_000)

  it('gives the same volume with the spline authored end-first', async () => {
    // The chainer reaches this spline from its (0, 0) end, so it is traversed
    // backward: the reversal must carry the poles and knots with it.
    const reversed = await build([0, 0, 5, 8, 10, 10.0000005])
    const exact = await build([10, 10, 5, 8, 0, 0])
    expect(Math.abs(reversed.volume - exact.volume)).toBeLessThanOrEqual(Math.abs(exact.volume) * 1e-6)
  }, 120_000)
})
