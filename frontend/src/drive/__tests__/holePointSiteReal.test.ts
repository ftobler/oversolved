// @vitest-environment node
//
// The two lanes for one bore. A hole drills a sketch POINT at the feature
// `diameter`; a circle is a profile, and cutting it is an extrude `cut`
// (`through_all` for a through bore). Both remove the same cylinder, so the
// measured volumes must agree. Real OCC + Rust solver.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
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

// A 20 x 20 x 10 plate centred on the origin, a 6 mm bore through it.
const PLATE = 20 * 20 * 10
const R = 3
const BORE = Math.PI * R * R * 10

function plate(): ScriptStep[] {
  return [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' } },
    {
      mutation: {
        type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [10, 10],
        centerRef: '@builtin_origin', dimensions: true,
      },
    },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
  ]
}

const HOLE_STEPS: ScriptStep[] = [
  ...plate(),
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Bore point', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [0, 0], entityId: 'p1' } },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
      targets: ['vertex:sk2:p1:xy', '@builtin_origin'],
    },
  },
  {
    mutation: {
      type: 'add_hole', featureId: 'h1', label: 'Bore', sketch: '@sk2',
      diameter: 2 * R, depth_mode: 'through_all',
    },
  },
]

const CIRCLE_CUT_STEPS: ScriptStep[] = [
  ...plate(),
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Bore circle', plane: '@builtin_plane_front' } },
  {
    mutation: {
      type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, R],
      entityId: 'c1', dimensions: true,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
      targets: ['vertex:sk2:c1:center', '@builtin_origin'],
    },
  },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex2', label: 'Bore cut', sketchQuery: 'entity:sk2:c1',
      distance: 1, operation: 'cut', termination: 'through_all', direction: 'symmetric',
    },
  },
]

describe.skipIf(!ready)('one bore, two lanes (real OCC + Rust solver)', () => {
  it('a point-site through hole removes pi r^2 h at the feature diameter', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: HOLE_STEPS })
    expect(nonSketchProblems(built.features)).toEqual([])
    const measured = await measureHeadless(built.doc as PartDoc)
    expect(measured!.measures.volume).toBeCloseTo(PLATE - BORE, 2)
  }, 120_000)

  it('a circle extruded as a cut removes the same cylinder', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: CIRCLE_CUT_STEPS })
    expect(nonSketchProblems(built.features)).toEqual([])
    const measured = await measureHeadless(built.doc as PartDoc)
    expect(measured!.measures.volume).toBeCloseTo(PLATE - BORE, 2)
  }, 120_000)

  it('the hole and the extrude cut agree, each in its own lane', async () => {
    const hole = await measureHeadless((await runHeadless({ doc: emptyDriveDoc(), steps: HOLE_STEPS })).doc as PartDoc)
    const cut = await measureHeadless((await runHeadless({ doc: emptyDriveDoc(), steps: CIRCLE_CUT_STEPS })).doc as PartDoc)
    expect(hole!.measures.volume).toBeCloseTo(cut!.measures.volume, 6)
  }, 240_000)
})
