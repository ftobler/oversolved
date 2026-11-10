// @vitest-environment node
//
// A point toggled to construction is reference geometry: the report's CadQuery
// `rect(forConstruction=True).vertices().hole(d)` idiom drills the four corner
// points and skips the helper centre point. Before the toggle applied to
// points the step returned an `ok` with the same docHash and the centre point
// kept drilling (Ex016 F1). Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  runHeadless, measureHeadless, selectHeadless, emptyDriveDoc, type HeadlessRunResult,
} from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { docHashOf } from '../docHash'
import { featureById } from '@/testing/featureAccess'
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

// The plate is 2 x 2 x 0.5, so one through bore is pi r^2 * 0.5.
const PLATE_VOLUME = 2 * 2 * 0.5
const BORE_RADIUS = 0.0625
const ONE_BORE = Math.PI * BORE_RADIUS * BORE_RADIUS * 0.5
// The report's measured volume: four corner bores and no centre bore.
const REPRO_VOLUME = 1.975456

async function buildPlate(): Promise<HeadlessRunResult> {
  return runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [-1, -1], p1: [1, 1] } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 0.5, operation: 'new' } },
    ],
  })
}

async function topFace(doc: PartDoc): Promise<string> {
  const selected = await selectHeadless(doc, {
    kind: 'face',
    where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
  })
  expect(selected!.queries).toHaveLength(1)
  return selected!.queries[0]
}

// A 2 x 2 plate with a second sketch on its top face. Every case below authors
// into that sketch, so the body and the plane are the same throughout.
async function topSketchDoc(): Promise<PartDoc> {
  const plate = await buildPlate()
  expect(nonSketchProblems(plate.features)).toEqual([])
  const sketched = await runHeadless({
    doc: plate.doc!,
    steps: [{ mutation: { type: 'add_sketch', featureId: 'sk2', plane: await topFace(plate.doc!) } }],
  })
  expect(sketched.ok).toBe(true)
  return sketched.doc!
}

async function centreRect(doc: PartDoc): Promise<HeadlessRunResult> {
  const rect = await runHeadless({
    doc,
    steps: [
      { mutation: { type: 'add_center_rect', featureId: 'sk2', center: [0, 0], corner: [0.75, 0.75] } },
    ],
  })
  expect(rect.ok).toBe(true)
  return rect
}

describe.skipIf(!ready)('toggle_construction on a point (real kernel)', () => {
  it('changes the document and sets the flag on the helper centre point', async () => {
    const rect = await centreRect(await topSketchDoc())
    // add_center_rect creates the four lines then the centre point.
    const created = rect.outcome.steps[0].createdIds
    expect(created).toHaveLength(5)
    const centre = created[4]

    const toggled = await runHeadless({
      doc: rect.doc!,
      steps: [{ mutation: { type: 'toggle_construction', targets: [`entity:sk2:${centre}`] } }],
    })
    expect(toggled.ok).toBe(true)
    // The failing report returned an ok whose hash equalled the input hash.
    expect(toggled.docHash).not.toBe(docHashOf(rect.doc!))
    const point = featureById(toggled.doc!, 'sk2', 'sketch').entities!.find(e => e.id === centre)
    expect(point).toMatchObject({ kind: 'point', construction: true })
  }, 120_000)

  it('flagging the only drill site fails by name, and clearing it brings the bore back', async () => {
    const built = await runHeadless({
      doc: await topSketchDoc(),
      steps: [
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [0, 0], entityId: 'p1' } },
        { mutation: { type: 'add_hole', featureId: 'h1', sketch: '@sk2', diameter: 0.125, depth_mode: 'through_all' } },
      ],
    })
    expect(nonSketchProblems(built.features)).toEqual([])
    const before = (await measureHeadless(built.doc!))!.measures.volume
    expect(before).toBeCloseTo(PLATE_VOLUME - ONE_BORE, 6)

    const flagged = await runHeadless({
      doc: built.doc!,
      steps: [{ mutation: { type: 'toggle_construction', targets: ['entity:sk2:p1'] } }],
    })
    const problem = flagged.features.find(feature => feature.id === 'h1')
    expect(problem?.message).toMatch(
      /has only construction points and circles.*clear a point's or circle's construction flag/,
    )

    const cleared = await runHeadless({
      doc: flagged.doc!,
      steps: [{ mutation: { type: 'toggle_construction', targets: ['entity:sk2:p1'] } }],
    })
    expect(nonSketchProblems(cleared.features)).toEqual([])
    const after = (await measureHeadless(cleared.doc!))!.measures.volume
    expect(after).toBeCloseTo(before, 6)
  }, 180_000)

  it('the Ex016 repro drills the four corner points and skips the centre point', async () => {
    const rect = await centreRect(await topSketchDoc())
    const targets = rect.outcome.steps[0].createdIds.map(id => `entity:sk2:${id}`)
    expect(targets).toHaveLength(5)

    const corners: Array<[string, number, number]> = [
      ['c_lo_lo', -0.75, -0.75],
      ['c_hi_lo', 0.75, -0.75],
      ['c_hi_hi', 0.75, 0.75],
      ['c_lo_hi', -0.75, 0.75],
    ]
    const steps: ScriptStep[] = [
      { mutation: { type: 'toggle_construction', targets } },
      ...corners.map(([entityId, x, y]) => ({
        mutation: { type: 'add_entity' as const, featureId: 'sk2', kind: 'point', params: [x, y], entityId },
      })),
      { mutation: { type: 'add_hole', featureId: 'h1', sketch: '@sk2', diameter: 0.125, depth_mode: 'through_all' } },
    ]
    const built = await runHeadless({ doc: rect.doc!, steps })
    expect(built.ok).toBe(true)
    expect(nonSketchProblems(built.features)).toEqual([])

    const measured = await measureHeadless(built.doc!)
    expect(measured!.ok).toBe(true)
    // Four bores. Five would be 1.96932, the pre-fix answer with the centre
    // point still a drill site.
    expect(measured!.measures.volume).toBeCloseTo(REPRO_VOLUME, 6)
  }, 180_000)
})
