// @vitest-environment node
//
// The two lanes for one bore. A hole drills a sketch POINT at the feature
// `diameter`; a circle is a profile, and cutting it is an extrude `cut`
// (`through_all` for a through bore). Both remove the same cylinder, so the
// measured volumes must agree. Real OCC + Rust solver.
//
// This is the lane-equivalence guard: it would also pass on the old
// circle-site code, so the red-first proof for the rule lives in hole.test.ts,
// holeReal.test.ts, holeCounterboreReal.test.ts and the drive value test.

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
    expect(measured).not.toBeNull()
    expect(measured!.measures.volume).toBeCloseTo(PLATE - BORE, 2)
  }, 120_000)

  it('a circle extruded as a cut removes the same cylinder', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: CIRCLE_CUT_STEPS })
    expect(nonSketchProblems(built.features)).toEqual([])
    const measured = await measureHeadless(built.doc as PartDoc)
    expect(measured).not.toBeNull()
    expect(measured!.measures.volume).toBeCloseTo(PLATE - BORE, 2)
  }, 120_000)

  it('the hole and the extrude cut agree, each in its own lane', async () => {
    const hole = await measureHeadless((await runHeadless({ doc: emptyDriveDoc(), steps: HOLE_STEPS })).doc as PartDoc)
    const cut = await measureHeadless((await runHeadless({ doc: emptyDriveDoc(), steps: CIRCLE_CUT_STEPS })).doc as PartDoc)
    expect(hole).not.toBeNull()
    expect(cut).not.toBeNull()
    expect(hole!.measures.volume).toBeCloseTo(cut!.measures.volume, 6)
  }, 240_000)
})

// Since projection-constraint a projected point is an ordinary point held by a
// `projection` constraint, so the projection itself is a drill site. The recipe
// therefore adds only the projected origin; a second point coincident to it is
// an authoring slip that drills nothing. This is the end-to-end guard the MCP
// instructions teach, including the volume, so a swallowed site can never come
// back as a partial hole over a correct cut.
const PROJ_CB_R = 11
const PROJ_BORE_R = 6
const PROJ_CB_DEPTH = 7
// The r11 counterbore takes 7 mm of the 10 mm plate, the r6 bore the last 3.
const PROJ_COUNTERBORED = Math.PI * PROJ_CB_R * PROJ_CB_R * PROJ_CB_DEPTH
  + Math.PI * PROJ_BORE_R * PROJ_BORE_R * (10 - PROJ_CB_DEPTH)

/** A 60 x 80 x 10 plate, an offset plane at its top face, and the origin projected into it. */
function projectedSite(twin: boolean): ScriptStep[] {
  const steps: ScriptStep[] = [
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' } },
    {
      mutation: {
        type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [30, 40],
        centerRef: '@builtin_origin', dimensions: true,
      },
    },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
    {
      mutation: {
        type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 10 },
      },
    },
    { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Top face', plane: '@pl1' } },
    { mutation: { type: 'add_projected_entity', featureId: 'sk2', kind: 'point', source: '@builtin_origin', entityId: 'o' } },
  ]
  if (twin) {
    steps.push({ mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [0, 0], entityId: 'p' } })
    steps.push({
      mutation: {
        type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
        targets: ['vertex:sk2:p:xy', 'vertex:sk2:o:xy'],
      },
    })
  }
  steps.push({
    mutation: {
      type: 'add_hole', featureId: 'h1', label: 'Counterbore', sketch: '@sk2', diameter: 2 * PROJ_BORE_R,
      depth_mode: 'through_all', style: 'counterbore', cb_diameter: 2 * PROJ_CB_R, cb_depth: PROJ_CB_DEPTH,
    },
  })
  return steps
}

describe.skipIf(!ready)('the projected origin is the drill site (real OCC + Rust solver)', () => {
  it('a point coincident to the projected origin is a swallowed site, not a partial hole', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: projectedSite(true) })
    const measure = await measureHeadless(built.doc as PartDoc)
    expect(measure).not.toBeNull()
    expect(measure!.measures.volume).toBeCloseTo(60 * 80 * 10 - PROJ_COUNTERBORED, 2)
    // The warning is the one problem row, and it is a warning on an ok hole:
    // no partial miss, and no contradicting merge note.
    expect(built.features.map(feature => feature.id)).toEqual(['h1'])
    const hole = built.features[0]
    expect(hole.status).toBe('ok')
    expect(hole.message).toContain('sits on site o and drills nothing')
    expect(hole.message).toContain('(o is the projection of @builtin_origin)')
    expect(hole.message).not.toMatch(/did not intersect|merge into one cut/)
  }, 180_000)

  it('the projected origin alone cuts the same counterbore with no warning', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: projectedSite(false) })
    const measure = await measureHeadless(built.doc as PartDoc)
    expect(built.features).toEqual([])
    expect(measure).not.toBeNull()
    expect(measure!.measures.volume).toBeCloseTo(60 * 80 * 10 - PROJ_COUNTERBORED, 2)
  }, 180_000)
})
