// @vitest-environment node
//
// The multi-region cap repro through the whole drive path (plan
// bug-multi-region-cap-identity, MCP practice 02_cadquery rpi3b F1).
//
// A plate carries three disjoint chip profiles added onto its top. A face
// sketch sits on the middle chip's cap. Deleting the first chip's lines must
// leave the face sketch on the middle chip: the stored query follows the
// region's own profile entities, never the loop ordinal (which used to hand the
// middle chip's name to the third chip).
//
// Real kernel, gated like the other drive suites.

import { describe, it, expect } from 'vitest'
import { runHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import type { ScriptStep } from '../scriptRunner'
import type { FaceGeometry, Selector } from '@/kernel/select'
import type { PartDoc } from '@/types/cad'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

/** One 4 x 4 chip profile on the plate top, at world x. */
function chip(x: number, prefix: string): ScriptStep[] {
  return [m({
    type: 'add_rect', featureId: 'sk3',
    p0: [x - 2, -2], p1: [x + 2, 2],
    entityIds: ['bottom', 'right', 'top', 'left'].map((side) => `${prefix}_${side}`),
  })]
}

/** The plate plus three chips added onto its top. */
const CHIPS: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
  m({ type: 'add_rect', featureId: 'sk1', p0: [-30, -10], p1: [30, 10] }),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2, operation: 'new' }),
  m({ type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 2 } }),
  m({ type: 'add_sketch', featureId: 'sk3', plane: '@pl2' }),
  ...chip(-20, 'a'),
  ...chip(0, 'b'),
  ...chip(20, 'c'),
  m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk3', distance: 1, operation: 'add' }),
]

const A_LINES = ['a_bottom', 'a_right', 'a_top', 'a_left'].map((id) => `entity:sk3:${id}`)

describe.skipIf(!ready)('multi-region cap identity drive path (real OCC + Rust solver)', () => {
  it('a face sketch on the middle chip stays there after the first chip is deleted', async () => {
    let result = await runHeadless({ doc: emptyDriveDoc(), steps: CHIPS })
    expect(nonSketchProblems(result.features)).toEqual([])
    const built = result.doc as PartDoc

    // The middle chip's top cap, picked by geometry test-side only.
    const selector: Selector = {
      kind: 'face',
      where: { and: [{ created_by: 'ex2' }, { parallel: [0, 1, 0] }] },
    }
    const caps = await selectHeadless(built, selector)
    const middle = caps?.items.find((item) => {
      const face = item.geometry as FaceGeometry
      return Math.abs(face.centroid[0]) < 1e-6 && Math.abs(face.centroid[1] - 3) < 1e-6
    })
    expect(middle, 'the middle chip has a top cap').toBeDefined()

    result = await runHeadless({
      doc: built,
      steps: [
        m({ type: 'add_sketch', featureId: 'sk7', plane: middle!.query }),
        m({ type: 'add_entity', featureId: 'sk7', kind: 'circle', params: [0, 0, 1] }),
      ],
      frames: 'all',
    })
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.frames?.['sk7']?.origin[0]).toBeCloseTo(0, 6)

    // Delete the first chip's profile. The middle chip is untouched, so the
    // face sketch's frame must not move to the third chip at x = 20.
    result = await runHeadless({
      doc: result.doc as PartDoc,
      steps: [m({ type: 'delete', targets: A_LINES })],
      frames: 'all',
    })
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.frames?.['sk7']?.origin[0], 'sk7 stays on the middle chip').toBeCloseTo(0, 6)
    expect(result.frames?.['sk7']?.origin[0]).not.toBeCloseTo(20, 6)
  })
})
