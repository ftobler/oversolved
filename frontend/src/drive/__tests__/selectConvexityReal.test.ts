// @vitest-environment node
//
// The real-kernel half of the two edge-only selector leaves, `convexity` and
// `seam`. The convexity fixture is modelled on the 80-20 rail's two-radius
// fillet job: a plate with four rectangular through slots gives the same shape
// of problem from construction (each slot contributes four vertical concave
// corners; the mouth rims and the plate's outer edges are convex). The seam
// fixture is a revolved, inward-shelled cup, the tea_cup shape. A second case
// edits the plate parametrically and re-selects, proving the predicate is
// re-evaluated rather than stored.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

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
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

// Four 12x6 slots through an 80x50x8 plate. Every count below is fixed by
// this construction, not by a hand count of a production document: four slots
// x four vertical corners is 16 concave edges (the rail's 16 slot rounds), and
// the twelve outer plate edges plus eight mouth-rim edges per slot is 44
// convex edges.
const SLOT_COUNT = 4
const CONCAVE_EDGES = SLOT_COUNT * 4
const CONVEX_EDGES = 12 + SLOT_COUNT * 8

function plateSteps(): ScriptStep[] {
  return [
    step({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    step({ type: 'add_rect', featureId: 'sk1', p0: [-40, -25], p1: [40, 25] }),
    step({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 8, operation: 'new' }),
    step({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' }),
    step({ type: 'add_rect', featureId: 'sk2', p0: [-26, -13], p1: [-14, -7] }),
    step({ type: 'add_rect', featureId: 'sk2', p0: [14, -13], p1: [26, -7] }),
    step({ type: 'add_rect', featureId: 'sk2', p0: [-26, 7], p1: [-14, 13] }),
    step({ type: 'add_rect', featureId: 'sk2', p0: [14, 7], p1: [26, 13] }),
    step({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 8, operation: 'cut', termination: 'through_all' }),
  ]
}

describe.skipIf(!ready)('select by convexity feeds a fillet group (real OCC)', () => {
  /** Solve the base plate once, so both groups are selected against the same
   *  document and the counts stay independent of a fillet. */
  async function baseDoc(): Promise<PartDoc> {
    const built = await runHeadless({ doc: emptyDoc(), steps: plateSteps() })
    expect(built.ok).toBe(true)
    return built.doc as PartDoc
  }

  it('selects the concave slot corners and the convex outer group', async () => {
    const doc = await baseDoc()
    const concave = (await selectHeadless(doc, {
      kind: 'edge',
      where: { convexity: 'concave' },
    }))!
    const convex = (await selectHeadless(doc, {
      kind: 'edge',
      where: { convexity: 'convex' },
    }))!
    expect(concave.queries).toHaveLength(CONCAVE_EDGES)
    expect(convex.queries).toHaveLength(CONVEX_EDGES)
    // Every selected item reports the class it was selected by, so the
    // discovery field and the predicate agree.
    for (const item of concave.items) expect(item.geometry).toMatchObject({ convexity: 'concave' })
    for (const item of convex.items) expect(item.geometry).toMatchObject({ convexity: 'convex' })
  }, 240_000)

  it('fillets the 16 concave slot corners and adds material', async () => {
    const doc = await baseDoc()
    const baseVolume = (await measureHeadless(doc))!.measures.volume
    const filleted = await runHeadless({
      doc,
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: [{ selector: { kind: 'edge', where: { convexity: 'concave' } } }],
        // The rail's concave round radius, so the recipe's first group is the
        // one being exercised rather than an arbitrary number.
        radius: 1.524,
      })],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find(problem => problem.id === 'fi1')).toBeUndefined()
    const feature = filleted.doc?.features?.find(candidate => candidate.id === 'fi1')
    if (feature?.kind !== 'fillet') throw new Error('unreachable: fillet was not stored')
    expect(feature.fillet.edges).toHaveLength(CONCAVE_EDGES)
    // A concave corner fillet fills the valley, so the part grows.
    const volume = (await measureHeadless(filleted.doc as PartDoc))!.measures.volume
    expect(volume).toBeGreaterThan(baseVolume)
  }, 240_000)

  it('fillets the convex group and removes material', async () => {
    const doc = await baseDoc()
    const baseVolume = (await measureHeadless(doc))!.measures.volume
    const filleted = await runHeadless({
      doc,
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: [{ selector: { kind: 'edge', where: { convexity: 'convex' } } }],
        // The rail's convex round radius.
        radius: 0.762,
      })],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find(problem => problem.id === 'fi1')).toBeUndefined()
    const feature = filleted.doc?.features?.find(candidate => candidate.id === 'fi1')
    if (feature?.kind !== 'fillet') throw new Error('unreachable: fillet was not stored')
    expect(feature.fillet.edges).toHaveLength(CONVEX_EDGES)
    // A convex ridge fillet cuts the corner away, so the part shrinks.
    const volume = (await measureHeadless(filleted.doc as PartDoc))!.measures.volume
    expect(volume).toBeLessThan(baseVolume)
  }, 240_000)

  it('re-evaluates the groups after a parametric edit in the same chain', async () => {
    const doc = await baseDoc()
    // The plate thickness changes, so every edge is rebuilt. Selecting against
    // the edited document must come back with the same 16/44 groups, and a
    // fillet authored with a selector in the same chain must store exactly
    // those queries: the predicate is re-evaluated, never cached.
    const edited = await runHeadless({
      doc,
      steps: [step({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 12 })],
    })
    expect(edited.ok).toBe(true)
    const concave = (await selectHeadless(edited.doc as PartDoc, {
      kind: 'edge',
      where: { convexity: 'concave' },
    }))!
    const convex = (await selectHeadless(edited.doc as PartDoc, {
      kind: 'edge',
      where: { convexity: 'convex' },
    }))!
    expect(concave.queries).toHaveLength(CONCAVE_EDGES)
    expect(convex.queries).toHaveLength(CONVEX_EDGES)

    const filleted = await runHeadless({
      doc: edited.doc as PartDoc,
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: [{ selector: { kind: 'edge', where: { convexity: 'concave' } } }],
        radius: 1.524,
      })],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find(problem => problem.id === 'fi1')).toBeUndefined()
    const feature = filleted.doc?.features?.find(candidate => candidate.id === 'fi1')
    if (feature?.kind !== 'fillet') throw new Error('unreachable: fillet was not stored')
    expect(feature.fillet.edges).toEqual(concave.queries)
  }, 240_000)
})

// ─── the seam predicate on a revolved, shelled body ───

// A cup built the way the tea_cup practice run's bowl was: a 360 degree
// revolve, then a 2 mm inward shell with the top face removed. From this
// construction the body has 6 edges: two lateral seams (the outer and inner
// cylinder faces each meet themselves) and four circular boundary rims (outer
// top, inner top, outer bottom, inner bottom). A different bowl splits into a
// different number of seams, so these counts describe this fixture only.
const CUP_EDGES = 6
const CUP_SEAMS = 2
const CUP_BOUNDARY = CUP_EDGES - CUP_SEAMS

async function cupDoc(): Promise<PartDoc> {
  const solid = await runHeadless({
    doc: emptyDoc(),
    steps: [
      step({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      step({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 20] }),
      step({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' }),
      step({ type: 'add_entity', featureId: 'sk2', kind: 'line', params: [0, -5, 0, 25], entityId: 'ax' }),
      step({ type: 'add_revolve', featureId: 'rv1', sketchQuery: '$sk1', angle: 360, axis: '@sk2/ax' }),
    ],
  })
  expect(solid.ok).toBe(true)
  expect(solid.features).toEqual([])
  // The cup's open top is the max face along the revolve axis (world +Y).
  const top = (await selectHeadless(solid.doc as PartDoc, {
    kind: 'face',
    where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
  }))!
  expect(top.queries).toHaveLength(1)
  const shelled = await runHeadless({
    doc: solid.doc as PartDoc,
    steps: [step({
      type: 'add_shell', featureId: 'sh1',
      faces: top.queries, thickness: 2, direction: 'inward',
    })],
  })
  expect(shelled.ok).toBe(true)
  expect(shelled.features).toEqual([])
  return shelled.doc as PartDoc
}

describe.skipIf(!ready)('select by seam on a revolved shell (real OCC)', () => {
  it('reports this construction\'s edge and seam counts, and not({seam:true}) equals seam:false', async () => {
    const doc = await cupDoc()
    const all = (await selectHeadless(doc, { kind: 'edge' }))!
    const seams = (await selectHeadless(doc, { kind: 'edge', where: { seam: true } }))!
    const boundary = (await selectHeadless(doc, { kind: 'edge', where: { seam: false } }))!
    const negated = (await selectHeadless(doc, { kind: 'edge', where: { not: { seam: true } } }))!
    expect(all.queries).toHaveLength(CUP_EDGES)
    expect(seams.queries).toHaveLength(CUP_SEAMS)
    expect(boundary.queries).toHaveLength(CUP_BOUNDARY)
    expect(negated.queries).toEqual(boundary.queries)
    for (const item of seams.items) expect(item.geometry).toMatchObject({ seam: true })
    for (const item of boundary.items) expect(item.geometry).toMatchObject({ seam: false })
    // The two sets partition every edge, with no overlap or loss.
    expect([...seams.queries, ...boundary.queries].sort()).toEqual([...all.queries].sort())
  }, 240_000)

  it('fillets exactly the boundary edges the seam:false group names', async () => {
    const doc = await cupDoc()
    const boundary = (await selectHeadless(doc, { kind: 'edge', where: { seam: false } }))!
    expect(boundary.queries).toHaveLength(CUP_BOUNDARY)
    const filleted = await runHeadless({
      doc,
      steps: [step({
        type: 'add_fillet', featureId: 'fi1',
        edges: boundary.queries,
        radius: 0.5,
      })],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.features.find(problem => problem.id === 'fi1')).toBeUndefined()
    const feature = filleted.doc?.features?.find(candidate => candidate.id === 'fi1')
    if (feature?.kind !== 'fillet') throw new Error('unreachable: fillet was not stored')
    expect(feature.fillet.edges).toEqual(boundary.queries)
  }, 240_000)
})
