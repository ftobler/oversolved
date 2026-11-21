// @vitest-environment node
//
// The documented body-mirror defaults, pinned on the real kernel. A 10 mm cube
// touching the Right plane mirrored across it with neither flag keeps the
// source and fuses the copy: one part of 2000 mm3. `merge: false` mints the
// copy as `body_mi1`, and a fused copy that does not reach the source resplits
// into separate parts because one part holds one solid. The catalog wording
// half is in catalogNotes.test.ts.

import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes
const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// A free fixture profile: the subject here is the mirror, and the
// underconstrained warning is the sketch's, not the feature's.
function cubeSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
  ]
}

function volumesOf(measured: Awaited<ReturnType<typeof measureHeadless>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of measured!.measures.perBody) out[part.id] = part.volume
  return out
}

describe.skipIf(!ready)('body mirror merge defaults (real OCC + Rust solver)', () => {
  it('keeps the source and fuses the copy when neither flag is sent', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...cubeSteps(),
        m({ type: 'add_mirror', featureId: 'mi1', body: 'body_ex1', plane: '@builtin_plane_right' }),
      ],
    })
    for (const step of result.outcome.steps) expect(step.ok, `${step.id}: ${step.error?.message ?? ''}`).toBe(true)
    expect(result.bodies).toEqual(['body_ex1'])

    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.measures.volume).toBeCloseTo(2000, 4)
  }, 240_000)

  it('mints body_mi1 as its own part with merge false', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...cubeSteps(),
        m({
          type: 'add_mirror', featureId: 'mi1', body: 'body_ex1',
          plane: '@builtin_plane_right', merge: false,
        }),
      ],
    })
    for (const step of result.outcome.steps) expect(step.ok, `${step.id}: ${step.error?.message ?? ''}`).toBe(true)
    expect([...result.bodies!].sort()).toEqual(['body_ex1', 'body_mi1'])

    const volumes = volumesOf(await measureHeadless(result.doc!))
    expect(volumes.body_ex1).toBeCloseTo(1000, 4)
    expect(volumes.body_mi1).toBeCloseTo(1000, 4)
  }, 240_000)

  it('resplits a fused copy that does not reach the source', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...cubeSteps(),
        m({ type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 20 } }),
        m({ type: 'add_mirror', featureId: 'mi1', body: 'body_ex1', plane: '@pl2' }),
      ],
    })
    for (const step of result.outcome.steps) expect(step.ok, `${step.id}: ${step.error?.message ?? ''}`).toBe(true)
    expect([...result.bodies!].sort()).toEqual(['body_ex1', 'body_ex1_1'])

    const volumes = volumesOf(await measureHeadless(result.doc!))
    expect(volumes.body_ex1).toBeCloseTo(1000, 4)
    expect(volumes.body_ex1_1).toBeCloseTo(1000, 4)
  }, 240_000)
})
