// @vitest-environment node
//
// `up_to` and `up_to_next` still need a `distance`, but the target decides the
// length. This pins the documented claim: any non-zero value builds the same
// solid, its sign does not change the direction, and 0 is still refused.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// A 10 x 10 plate 2 thick from the Front plane, then a 3 x 3 boss sketched on a
// plane 5 in front and swept back toward the plate. The stop is the plate's top
// face, so the boss is 3 long whatever `distance` says.
const PLATE = 10 * 10 * 2
const BOSS = 3 * 3 * 3

async function build(distance: number) {
  return runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2, operation: 'new' }),
      m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 } }),
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
      m({ type: 'add_rect', featureId: 'sk2', p0: [3, 3], p1: [6, 6] }),
      m({
        type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance,
        direction: 'reverse', termination: 'up_to_next', operation: 'add',
      }),
    ],
  })
}

describe.skipIf(!ready)('an up_to_next extrude stores distance but never uses it (real OCC + Rust solver)', () => {
  it('builds the same boss for distance 1, 50 and -1', async () => {
    for (const distance of [1, 50, -1]) {
      const result = await build(distance)
      expect(nonSketchProblems(result.features)).toEqual([])
      expect(result.part.solveOutcomes().ex2?.status, `distance ${distance}`).toBe('ok')
      const measured = await measureHeadless(result.doc as PartDoc)
      expect(measured!.measures.volume, `distance ${distance}`).toBeCloseTo(PLATE + BOSS, 3)
    }
  }, 300_000)

  it('still refuses a zero distance and leaves the plate untouched', async () => {
    const result = await build(0)
    expect(result.features.find(feature => feature.id === 'ex2')?.message).toContain('distance must be non-zero')
    const measured = await measureHeadless(result.doc as PartDoc)
    expect(measured!.measures.volume).toBeCloseTo(PLATE, 3)
  }, 120_000)
})
