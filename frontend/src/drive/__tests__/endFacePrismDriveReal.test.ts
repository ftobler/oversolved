// @vitest-environment node
//
// The enclosure lip fillet through the whole drive path (plan
// bug-fillet-end-cap-sliver).
//
// The reported document (run 06_other_text_cad__kcl-samples__enclosure__main.kcl,
// report F1) builds fi3, the r9 lip fillet, with no problem row: the blend is
// built by the prism cut and the note says so on the informational channel.
// Then the blend face is picked, a chamfer is authored on one of its boundary
// edges, and the fillet radius is changed to 8: the pick has to keep resolving,
// which is what makes the fallback's blend-face UUID indistinguishable from the
// rolling ball's.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import type { ScriptStep } from '../scriptRunner'
import type { Selector } from '@/kernel/select'
import type { FaceGeometry } from '@/kernel/select'
import type { PartDoc } from '@/types/cad'
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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const NOTE = 'fillet: edges[0], edges[1], edges[2], edges[3] blended by a prism cut ' +
  'because the rolling-ball blend could not consume its end face'
/** 4 * (1 - pi/4) * 9^2 * 3: the four overhang corner wedges. */
const CORNER_CUTS = 4 * (1 - Math.PI / 4) * 81 * 3

async function apply(doc: PartDoc, mutation: Record<string, unknown>) {
  const result = await runHeadless({ doc, steps: [m(mutation)] })
  const id = mutation.featureId as string
  return { result, problem: result.features.find(feature => feature.id === id) }
}

async function pick(doc: PartDoc, selector: Selector): Promise<string[]> {
  return (await selectHeadless(doc, selector))!.queries
}

async function volume(doc: PartDoc): Promise<number> {
  return (await measureHeadless(doc))!.measures.volume
}

/**
 * The enclosure's plate and lip, rebuilt from the finding text: 40 x 30 x 3 on
 * Top, four upright edges r12, then a 34 x 24 lip inset 3 on a plane 3 further
 * out, extruded 3 and added. The app's Top plane normal is +Y, so the lip that
 * sits on the plate's far face is the plane at offset -3. Returns the document
 * before the lip fillet and the four lip upright edge queries.
 */
async function enclosure(): Promise<{ doc: PartDoc; lipEdges: string[] }> {
  const PLATE: ScriptStep[] = [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, operation: 'new' }),
  ]
  let result = await runHeadless({ doc: emptyDriveDoc(), steps: PLATE })
  expect(nonSketchProblems(result.features)).toEqual([])
  let doc = result.doc as PartDoc

  const plateUprights = await pick(doc, { kind: 'edge', where: { parallel: [0, 1, 0] } })
  expect(plateUprights).toHaveLength(4)
  result = await runHeadless({ doc, steps: [m({ type: 'add_fillet', featureId: 'fi1', edges: plateUprights, radius: 12 })] })
  expect(nonSketchProblems(result.features)).toEqual([])
  doc = result.doc as PartDoc

  for (const step of [
    { type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: -3 } },
    { type: 'add_sketch', featureId: 'sk2', plane: '@pl1' },
    { type: 'add_rect', featureId: 'sk2', p0: [3, 3], p1: [37, 27] },
    { type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 3, operation: 'add' },
  ]) {
    result = await runHeadless({ doc, steps: [m(step)] })
    expect(nonSketchProblems(result.features)).toEqual([])
    doc = result.doc as PartDoc
  }

  // The lip's uprights span y in [-3, 0]; the plate's rounded corners leave
  // upright seams above that, so the range separates them.
  const lipEdges = await pick(doc, {
    kind: 'edge',
    where: { and: [{ parallel: [0, 1, 0] }, { within: { axis: 'y', max: 0.1 } }] },
  })
  expect(lipEdges).toHaveLength(4)
  return { doc, lipEdges }
}

describe.skipIf(!ready)('enclosure lip fillet drive path (real OCC + Rust solver)', () => {
  it('builds fi3 at r9 with the fallback note and no problem row', async () => {
    const { doc, lipEdges } = await enclosure()
    const before = await volume(doc)
    const { result, problem } = await apply(doc, { type: 'add_fillet', featureId: 'fi3', edges: lipEdges, radius: 9 })
    expect(problem).toBeUndefined()
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.notes).toEqual([{ ids: ['fi3'], text: NOTE }])
    // The authored radius removes exactly the four overhang wedges and nothing
    // else: the tool is wholly inside the lip at each corner.
    expect(await volume(result.doc as PartDoc)).toBeCloseTo(before - CORNER_CUTS, 6)
  }, 240_000)

  it('keeps a pick on the blend face through a radius change', async () => {
    const { doc, lipEdges } = await enclosure()
    const { result } = await apply(doc, { type: 'add_fillet', featureId: 'fi3', edges: lipEdges, radius: 9 })
    const built = result.doc as PartDoc
    const blends = await selectHeadless(built, {
      kind: 'face',
      where: { and: [{ type: 'cylinderface' }, { within: { axis: 'y', max: 0.1 } }] },
    })
    expect(blends!.queries).toHaveLength(4)
    const centroid = (blends!.items[0].geometry as FaceGeometry).centroid

    // A chamfer on one arc of that blend face: an edge the blend's own UUID
    // names, so the pick only resolves while the fallback keeps the identity a
    // rolling-ball fillet would have minted.
    const faceSelector: Selector = { kind: 'face', where: { center: { point: centroid, radius: 1e-6 } } }
    const boundary = (await selectHeadless(built, { kind: 'edge', where: { on_face: faceSelector } }))!
    const arc = boundary.items.find(item => item.geometry.kind === 'arc' || item.geometry.kind === 'circle')
    expect(arc).toBeDefined()

    const chamfered = await apply(built, { type: 'add_chamfer', featureId: 'ch2', edges: [arc!.query], distance: 0.2 })
    expect(chamfered.problem).toBeUndefined()
    expect(nonSketchProblems(chamfered.result.features)).toEqual([])

    // Change the radius: both features re-solve, and the blend face query is
    // the same one, so nothing was re-minted behind the pick's back.
    const changed = await apply(chamfered.result.doc as PartDoc, {
      type: 'set_fillet_field', featureId: 'fi3', field: 'radius', value: 8,
    })
    expect(changed.problem).toBeUndefined()
    expect(nonSketchProblems(changed.result.features)).toEqual([])
    const afterDoc = changed.result.doc as PartDoc
    const afterBlends = await selectHeadless(afterDoc, {
      kind: 'face',
      where: { and: [{ type: 'cylinderface' }, { within: { axis: 'y', max: 0.1 } }] },
    })
    expect(afterBlends!.queries).toHaveLength(4)
    // The construction UUIDs survive the radius change; the classifier tail of
    // the query may move with the geometry, the identity may not.
    const uuidOf = (queries: string[]): string[] =>
      queries.map((q) => q.match(/@u\|[^@;]+/)?.[0] ?? q).sort()
    expect(uuidOf(afterBlends!.queries)).toEqual(uuidOf(blends!.queries))
    expect(await volume(afterDoc)).toBeGreaterThan(await volume(built))
  }, 300_000)
})
