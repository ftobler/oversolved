// @vitest-environment node
//
// The tangent-chain warning on fillet/chamfer (plan
// fillet-chamfer-tangent-chain). OCC continues a blend across a G1 joint, so a
// single pick on a rounded loop edits the loop; the feature now says so instead
// of reporting a clean `ok`. The Ex020 repro is the smallest case: a 3 x 3 x
// 0.5 plate with R0.125 vertical fillets, then one top loop edge picked at
// R0.1, which measured the whole 8-edge loop's volume with no warning.
//
// The warning is checked against the geometry it describes: the one-pick
// result must equal the all-8-picks result, so the count is not a guess. A
// refused pick is named separately and keeps its chain out of the count.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { partSolvePayload } from '../solveWriteBack'
import { solveLocally, setOccLoader } from '@/kernel/solveLocally'
import type { ScriptStep } from '../scriptRunner'
import type { Selector } from '@/kernel/select'
import type { PartDoc } from '@/types/cad'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
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

async function build(steps: ScriptStep[]): Promise<PartDoc> {
  const result = await runHeadless({ doc: emptyDriveDoc(), steps })
  expect(result.features).toEqual([])
  return result.doc as PartDoc
}

async function pick(doc: PartDoc, selector: Selector): Promise<string[]> {
  return (await selectHeadless(doc, selector))!.queries
}

async function apply(doc: PartDoc, mutation: Record<string, unknown>) {
  const result = await runHeadless({ doc, steps: [m(mutation)] })
  const id = mutation.featureId as string
  return { result, problem: result.features.find(feature => feature.id === id) }
}

async function volume(doc: PartDoc): Promise<number> {
  return (await measureHeadless(doc))!.measures.volume
}

// Ex020: a 3 x 3 x 0.5 plate. Its top loop is 4 straight edges joined by 4
// fillet arcs once the vertical edges are rounded, all tangent.
const PLATE: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
  m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [3, 3] }),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 0.5, operation: 'new' }),
]

/** The plate with its four vertical edges filleted: the state every case starts
 *  from, rebuilt per case because a feature edit mutates the document. */
async function plate(): Promise<PartDoc> {
  const doc = await build(PLATE)
  const vertical = await pick(doc, { kind: 'edge', where: { parallel: [0, 0, 1] } })
  expect(vertical).toHaveLength(4)
  const fillet = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges: vertical, radius: 0.125 })
  expect(fillet.problem).toBeUndefined()
  // The session answers with the document it mutated; reads must use that one.
  return fillet.result.doc as PartDoc
}

/** Every edge of the plate's top loop: 4 lines and the 4 fillet arcs. */
async function topLoop(doc: PartDoc): Promise<string[]> {
  const edges = await pick(doc, { kind: 'edge', where: { within: { axis: 'z', min: 0.4 } } })
  expect(edges).toHaveLength(8)
  return edges
}

describe.skipIf(!ready)('fillet/chamfer tangent-chain warning (real OCC + Rust solver)', () => {
  it('one top edge of a filleted plate warns that the whole 8-edge loop was filleted', async () => {
    const one = await plate()
    const loop = await topLoop(one)
    const single = await apply(one, { type: 'add_fillet', featureId: 'fi2', edges: [loop[0]], radius: 0.1 })
    expect(single.problem?.status).toBe('ok')
    expect(single.problem?.message).toBe(
      'fillet: the picked edges continue along the tangent chain, so 8 edges were filleted (7 of them not picked)',
    )

    // The warning reports what happened: one pick and the whole loop measure the
    // same body. Only the volume comparison can prove the chain was taken.
    const all = await plate()
    const whole = await apply(all, { type: 'add_fillet', featureId: 'fi2', edges: await topLoop(all), radius: 0.1 })
    expect(whole.problem).toBeUndefined()
    const singleVolume = await volume(single.result.doc as PartDoc)
    expect(singleVolume).toBeCloseTo(await volume(whole.result.doc as PartDoc), 5)
    expect(singleVolume).toBeLessThan(4.5)
  }, 120_000)

  it('a chamfer propagates the same way and says so', async () => {
    const one = await plate()
    const single = await apply(one, { type: 'add_chamfer', featureId: 'ch2', edges: [(await topLoop(one))[0]], distance: 0.1 })
    expect(single.problem?.status).toBe('ok')
    expect(single.problem?.message).toBe(
      'chamfer: the picked edges continue along the tangent chain, so 8 edges were chamfered (7 of them not picked)',
    )

    const all = await plate()
    const whole = await apply(all, { type: 'add_chamfer', featureId: 'ch2', edges: await topLoop(all), distance: 0.1 })
    expect(whole.problem).toBeUndefined()
    expect(await volume(single.result.doc as PartDoc)).toBeCloseTo(await volume(whole.result.doc as PartDoc), 5)
  }, 120_000)

  it('a sharp corner is not a chain: one box edge reports no warning', async () => {
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
    ])
    const edges = await pick(doc, { kind: 'edge', where: { parallel: [0, 0, 1] } })
    expect(edges).toHaveLength(4)
    const fillet = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges: [edges[0]], radius: 1 })
    expect(fillet.problem).toBeUndefined()
  }, 120_000)

  it('a refused pick is named, while the applied pick still reports its chain', async () => {
    // A stadium plate with a 2 x 2 x 0.5 boss on top. At R0.5 a boss top edge
    // refuses (its side face is 0.5 tall) while the plate's top straight edge
    // applies and runs the 4-edge outer loop. The refusal is the problem row;
    // the chain note must describe the pick that applied (4 edges, 3 not
    // picked) and never count the refused edge as blended.
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 20, 0] }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [20, 5, 5, -90, 90] }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [20, 10, 0, 10] }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 5, 5, 90, 270] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
      m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 } }),
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
      m({ type: 'add_rect', featureId: 'sk2', p0: [9, 4], p1: [11, 6] }),
      m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 0.5, operation: 'add' }),
    ])
    const line = await pick(doc, {
      kind: 'edge',
      where: {
        and: [
          { within: { axis: 'z', min: 4.9, max: 5.1 } },
          { within: { axis: 'y', max: 0.1 } },
          { parallel: [1, 0, 0] },
        ],
      },
    })
    const boss = await pick(doc, { kind: 'edge', where: { and: [{ within: { axis: 'z', min: 5.4 } }, { parallel: [1, 0, 0] }] } })
    expect(line).toHaveLength(1)
    expect(boss).toHaveLength(2)

    const fillet = await apply(doc, { type: 'add_fillet', featureId: 'fi2', edges: [line[0], boss[0]], radius: 0.5 })
    expect(fillet.problem?.status).toBe('partial')
    expect(fillet.problem?.message).toContain('edge(s) could not be applied')

    const response = await solveLocally(partSolvePayload(fillet.result.doc as PartDoc, 'tangent-chain-partial'))
    const row = response?.result.fi2 as { status?: string; solver_warning?: string } | undefined
    expect(row?.status).toBe('partial')
    expect(row?.solver_warning).toBe(
      'fillet: the picked edges continue along the tangent chain, so 4 edges were filleted (3 of them not picked)',
    )
  }, 120_000)
})
