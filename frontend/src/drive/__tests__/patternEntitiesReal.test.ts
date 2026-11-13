// @vitest-environment node
//
// End to end through the real kernel: a profile patterned inside one sketch by
// one pattern_entities step and extruded once is the same solid as the row
// authored by hand, with no per-copy boolean. The gear-rack row (5 rounded
// teeth), the din rail's 39-slot plate the feature pattern timed out on, and
// the playing_cards plan copied into a second sketch on the same plane.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'
import { featureById } from '@/testing/featureAccess'
import {
  roundedRectProfile, roundedRectArea, slotProfile, slotArea, mergeProfiles, type ProfileBlocks,
} from '@/testing/sketchPatternFixtures'

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

const sketch = (id: string, plane: string, blocks: ProfileBlocks): SketchFeature =>
  ({ id, kind: 'sketch', plane, ...blocks })

const docOf = (...features: SketchFeature[]): PartDoc => ({ ...emptyDriveDoc(), features })

const extrude = (sketchId: string, distance: number, id = 'ex1'): ScriptStep =>
  ({ mutation: { type: 'add_extrude', featureId: id, sketchQuery: `$${sketchId}`, distance, operation: 'new' } })

async function volumeOf(doc: PartDoc, steps: ScriptStep[]): Promise<{ volume: number; doc: PartDoc }> {
  const run = await runHeadless({ doc, steps })
  expect(run.ok).toBe(true)
  expect(nonSketchProblems(run.features)).toEqual([])
  const measured = await measureHeadless(run.doc!)
  expect(measured?.ok).toBe(true)
  return { volume: measured!.measures.volume, doc: run.doc! }
}

// The rounded tooth: 1 wide, 1.2 tall, r 0.168 corner arcs (the report's root
// and tip radius), stepped at the rack's pitch.
const PITCH = 1.570796
const TOOTH = { w: 1, h: 1.2, r: 0.168 }
const TOOTH_IDS = ['b', 'r', 't', 'l', 'a1', 'a2', 'a3', 'a4']

describe.skipIf(!ready)('pattern_entities extrudes to the hand-authored solid (real kernel)', () => {
  it('the gear-rack row: 5 patterned teeth, one extrude, equal to 5 authored teeth', async () => {
    const one = roundedRectProfile('', 0, 0, TOOTH.w, TOOTH.h, TOOTH.r)
    const patterned = await volumeOf(docOf(sketch('sk1', '@builtin_plane_front', one)), [
      { mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: TOOTH_IDS, mode: 'linear', count: 5, pitch: PITCH } },
      extrude('sk1', 5),
    ])
    expect(featureById(patterned.doc, 'sk1', 'sketch').entities).toHaveLength(40)
    expect(patterned.volume).toBeCloseTo(5 * 5 * roundedRectArea(TOOTH.w, TOOTH.h, TOOTH.r), 6)

    const byHand = mergeProfiles(...Array.from({ length: 5 }, (_, i) =>
      roundedRectProfile(`t${i}_`, i * PITCH, 0, TOOTH.w, TOOTH.h, TOOTH.r)))
    const hand = await volumeOf(docOf(sketch('sk1', '@builtin_plane_front', byHand)), [extrude('sk1', 5)])
    expect(patterned.volume).toBeCloseTo(hand.volume, 6)
    expect(patterned.doc.features!.filter(f => f.kind === 'extrude')).toHaveLength(1)
  }, 180_000)

  it('the din rail plate: 39 slots from one slot, one extrude, the analytic volume', async () => {
    const plate: ProfileBlocks = {
      entities: ['pb', 'pr', 'pt', 'pl'].map(id => ({ id, kind: 'line' })),
      initial: { pb: [-500, 0, 500, 0], pr: [500, 0, 500, 35], pt: [500, 35, -500, 35], pl: [-500, 35, -500, 0] },
      constraints: [
        { id: 'pk1', kind: 'coincident', a: '$pbend', b: '$prstart' },
        { id: 'pk2', kind: 'coincident', a: '$prend', b: '$ptstart' },
        { id: 'pk3', kind: 'coincident', a: '$ptend', b: '$plstart' },
        { id: 'pk4', kind: 'coincident', a: '$plend', b: '$pbstart' },
      ],
    }
    const slot = slotProfile('s', -475, 17.5, 15, 6.2)
    const built = await volumeOf(docOf(sketch('sk1', '@builtin_plane_front', mergeProfiles(plate, slot))), [
      { mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: ['slo', 'shi', 'sar', 'sal'], mode: 'linear', count: 39, pitch: 25, direction: [1, 0] } },
      extrude('sk1', 1),
    ])
    expect(featureById(built.doc, 'sk1', 'sketch').entities).toHaveLength(4 + 39 * 4)
    expect(slotArea(15, 6.2)).toBeCloseTo(84.7507054, 6)
    expect(built.volume).toBeCloseTo(1000 * 35 - 39 * slotArea(15, 6.2), 5)
    expect(built.volume).toBeCloseTo(31694.72248936108, 5)
  }, 180_000)

  it('the playing_cards plan copied into a second Front sketch, independent of the source', async () => {
    const plan = roundedRectProfile('', 0, 0, 71.5, 96.9, 4.233)
    const empty: ProfileBlocks = { entities: [], initial: {}, constraints: [] }
    const copyStep: ScriptStep = {
      mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: TOOTH_IDS, mode: 'copy', targetFeatureId: 'sk2' },
    }
    const copied = await runHeadless({
      doc: docOf(sketch('sk1', '@builtin_plane_front', plan), sketch('sk2', 'Front', empty)),
      steps: [copyStep],
    })
    // The source sketch is read-only for a copy, so the reply names sk2 only:
    // a sk1 row would report a zero the call did not author.
    expect(copied.featureDeltas?.map(row => row.id)).toEqual(['sk2'])
    const built = await volumeOf(docOf(
      sketch('sk1', '@builtin_plane_front', plan),
      sketch('sk2', 'Front', empty),
    ), [
      copyStep,
      extrude('sk2', 2),
    ])
    const sk2 = featureById(built.doc, 'sk2', 'sketch')
    expect(sk2.entities).toHaveLength(8)
    expect(sk2.constraints).toHaveLength(8)
    expect(built.volume).toBeCloseTo((71.5 * 96.9 - (4 - Math.PI) * 4.233 ** 2) * 2, 6)
    expect(built.volume).toBeCloseTo(13825.937618174597, 6)

    // Moving the source afterwards leaves the copy where it was.
    const copyParams = structuredClone(sk2.initial)
    const moved = await runHeadless({
      doc: built.doc,
      steps: [{ mutation: { type: 'move_entity', featureId: 'sk1', entityId: 'b', delta: [0, -3] } }],
    })
    expect(moved.ok).toBe(true)
    expect(featureById(moved.doc!, 'sk2', 'sketch').initial).toEqual(copyParams)

    // A copy into a Top sketch has no common frame and is refused by name.
    const refused = await runHeadless({
      doc: docOf(sketch('sk1', '@builtin_plane_front', plan), sketch('sk3', '@builtin_plane_top', empty)),
      steps: [{ mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: TOOTH_IDS, mode: 'copy', targetFeatureId: 'sk3' } }],
    })
    expect(refused.ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain('cannot map between different sketch planes')
  }, 180_000)
})
