// @vitest-environment node
//
// Overlapping drill sites from one point sketch merge into one cut; the hole
// used to say nothing (kcl bracket F3). The warning now names the pair, and
// sites that only sit near each other stay quiet. Real kernel.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

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

function steps(second: [number, number]): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
    { mutation: { type: 'add_rect', featureId: 'sk1', p0: [-20, -20], p1: [20, 20] } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5 } },
    { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' } },
    { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [0, 0] } },
    { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: second } },
    {
      mutation: {
        type: 'add_hole', featureId: 'h1', sketch: '@sk2', diameter: 6, depth_mode: 'through_all',
      },
    },
  ] as ScriptStep[]
}

describe.skipIf(!ready)('hole drill sites that overlap (real OCC + Rust solver)', () => {
  it('names the overlapping pair', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: steps([3, 0]) })
    const problem = result.features.find(feature => feature.id === 'h1')
    expect(problem?.message).toMatch(/drill sites overlap and merge into one cut: sites \S+, \S+/)
  }, 120_000)

  it('stays quiet for sites clear of each other', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: steps([10, 0]) })
    expect(result.features).toEqual([])
  }, 120_000)
})
