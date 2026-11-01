// @vitest-environment node
//
// A blind cut extruded from a face sketch goes along the face normal, out of
// the body, and used to fail with only "nothing to remove" (MCAD bearing F3).
// The miss now probes the opposite direction and names `direction: reverse`,
// as the outward blind hole does. Real kernel, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
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

const BOX_VOLUME = 40 * 30 * 10
const R = 3

async function cutOnTopFace(direction: string) {
  const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
  const built = await runHeadless({ doc: emptyDriveDoc(), steps: box.steps })
  const top = (await selectHeadless(built.doc!, {
    kind: 'face',
    where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
  }))!.queries
  expect(top).toHaveLength(1)
  const steps: ScriptStep[] = [
    { mutation: { type: 'add_sketch', featureId: 'sk2', plane: top[0] } },
    { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, R] } },
    { mutation: { type: 'add_extrude', featureId: 'cut1', sketchQuery: '$sk2', distance: 5 } },
    { mutation: { type: 'set_extrude_field', featureId: 'cut1', field: 'operation', value: 'cut' } },
    { mutation: { type: 'set_extrude_field', featureId: 'cut1', field: 'direction', value: direction } },
  ]
  return runHeadless({ doc: built.doc as PartDoc, steps })
}

describe.skipIf(!ready)('an outward face-sketch cut names direction: reverse', () => {
  it('a normal-direction cut that leaves the body names the flip', async () => {
    const result = await cutOnTopFace('normal')
    const problem = result.features.find(feature => feature.id === 'cut1')
    expect(problem?.message).toContain('`direction: reverse` cuts into it')
  }, 120_000)

  it('the reversed cut removes pi r^2 * 5', async () => {
    const result = await cutOnTopFace('reverse')
    expect(result.features).toEqual([])
    // The delta row names the body the cut went into, with its own volume.
    const row = result.featureDeltas!.find(delta => delta.id === 'cut1')!
    expect(row.body).toBe('body_ex1')
    expect(row.bodyVolume).toBeCloseTo(BOX_VOLUME - Math.PI * R * R * 5, 3)
    const measured = await measureHeadless(result.doc!)
    expect(measured!.measures.volume).toBeCloseTo(BOX_VOLUME - Math.PI * R * R * 5, 3)
  }, 120_000)
})
