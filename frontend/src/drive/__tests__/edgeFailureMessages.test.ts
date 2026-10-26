// @vitest-environment node
//
// Fillet, chamfer and shell failures that used to say only `build_failed`
// (plan mcp-practice-fixups-3, item G). Each shape is re-created from the
// practice reports' text:
// - MCAD boxes F1: a radius of half the face width consumes the face;
// - ppp0103 F1: a half-boss arc that runs tangentially into the plate's edges
//   refuses at every size, and used to sink a good edge picked with it;
// - cast_bearing_unit F2 / kcl enclosure F2: one refused edge in a batch is
//   named instead of "build_failed";
// - Case_Seam_Lip F4: an inward shell as thick as the fillets collapses them.
// Real kernel, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import type { Selector } from '@/kernel/select'
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

// The ppp0103 C-profile plate (16 thick) with an R8 half-boss at each end; the
// top boss's end arc continues tangentially into the plate's straight edges.
const PPP0103: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
  ...([
    ['line', [0, -47.5, 16, -47.5]], ['arc', [16, -29.5, 18, -90, 0]], ['line', [34, -29.5, 34, 29.5]],
    ['arc', [16, 29.5, 18, 0, 90]], ['line', [16, 47.5, 0, 47.5]], ['line', [0, 47.5, 0, 29.5]],
    ['line', [0, 29.5, 11, 29.5]], ['arc', [11, 22.5, 7, 0, 90]], ['line', [18, 22.5, 18, -26.5]],
    ['arc', [11, -26.5, 7, -90, 0]], ['line', [11, -33.5, 0, -33.5]], ['line', [0, -33.5, 0, -47.5]],
  ] as const).map(([kind, params]) => m({ type: 'add_entity', featureId: 'sk1', kind, params: [...params] })),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 16 }),
  m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 47.5 } }),
  m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
  m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, -8, 8] }),
  m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 18, direction: 'reverse' }),
  m({ type: 'add_plane', featureId: 'pl2', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: -33.5 } }),
  m({ type: 'add_sketch', featureId: 'sk3', plane: '@pl2' }),
  m({ type: 'add_entity', featureId: 'sk3', kind: 'circle', params: [0, -8, 8] }),
  m({ type: 'add_extrude', featureId: 'ex3', sketchQuery: '$sk3', distance: 23, direction: 'reverse' }),
]

describe.skipIf(!ready)('edge modifier and shell failure messages (real OCC + Rust solver)', () => {
  it('a radius of half the face width says it consumes the face', async () => {
    // 20 x 30 footprint extruded 40 along Y: the four Y edges bound the 20 mm faces.
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [20, 30] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 40 }),
    ])
    const edges = await pick(doc, { kind: 'edge', where: { parallel: [0, 1, 0] } })
    expect(edges).toHaveLength(4)
    const full = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges, radius: 10 })
    expect(full.problem?.message).toContain('radius 10 consumes the 20 mm face between the picked edges; use < 10')
    const fits = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges, radius: 9.99 })
    expect(fits.problem).toBeUndefined()
    expect(await volume(fits.result.doc as PartDoc)).toBeCloseTo(20 * 30 * 40 - (4 - Math.PI) * 9.99 ** 2 * 40, 3)
  }, 120_000)

  it('names the tangent chain instead of suggesting a smaller value, and builds a good edge as partial', async () => {
    const doc = await build(PPP0103)
    const arc = await pick(doc, { kind: 'edge', where: { and: [{ within: { axis: 'y', min: 47.4 } }, { type: 'arc' }] } })
    const circle = await pick(doc, { kind: 'edge', where: { and: [{ within: { axis: 'y', max: -56.4 } }, { type: 'circle' }] } })
    expect(arc).toHaveLength(1)
    expect(circle).toHaveLength(1)
    const before = await volume(doc)

    const alone = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges: arc, radius: 0.5 })
    expect(alone.problem?.status).toBe('exception')
    expect(alone.problem?.message).toContain('continues tangentially')
    expect(alone.problem?.message).toContain('pick the whole tangent chain')
    // Each neighbour once: the arc meets the plate's straight edge and the
    // boss's cylinder seam at its two ends, not each of them per adjacent face.
    expect(alone.problem?.message).toMatch(/continues tangentially into 2 unpicked edge\(s\)/)

    for (const mutation of [
      { type: 'add_fillet', featureId: 'fi1', edges: [...arc, ...circle], radius: 0.5 },
      { type: 'add_chamfer', featureId: 'fi1', edges: [...arc, ...circle], distance: 1 },
    ]) {
      const both = await apply(doc, mutation)
      expect(both.problem?.status, mutation.type).toBe('partial')
      expect(both.problem?.message, mutation.type).toMatch(/edges\[0\] \(curve at [^)]*\): the picked edge continues tangentially/)
      expect(await volume(both.result.doc as PartDoc), mutation.type).toBeLessThan(before - 1e-3)
    }
  }, 120_000)

  it('names the one edge of a batch that cannot fit, and builds the rest', async () => {
    // A 2 mm plate under a 10 mm block: r 3 fits the block's top edges but not
    // the plate's rim, whose side face is 2 mm tall.
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [-20, -20], p1: [20, 20] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2 }),
      m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 2 } }),
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
      m({ type: 'add_rect', featureId: 'sk2', p0: [-5, -5], p1: [5, 5] }),
      m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 10 }),
    ])
    const block = await pick(doc, { kind: 'edge', where: { and: [{ within: { axis: 'y', min: 11.9 } }, { parallel: [1, 0, 0] }] } })
    const rim = await pick(doc, {
      kind: 'edge',
      where: { and: [{ within: { axis: 'y', min: 1.9, max: 2.1 } }, { parallel: [1, 0, 0] }, { within: { axis: 'z', min: 19.9 } }] },
    })
    const { problem } = await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges: [...block, ...rim], radius: 3 })
    expect(problem?.status).toBe('partial')
    expect(problem?.message).toContain(`edges[${block.length}] (line at [0, 2, 20]): radius 3 consumes the 2 mm adjacent face`)
  }, 120_000)

  it('an inward shell as thick as the fillets names the fillet radius; outward builds', async () => {
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [30, 20] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 }),
    ])
    const vertical = await pick(doc, { kind: 'edge', where: { parallel: [0, 1, 0] } })
    const rounded = (await apply(doc, { type: 'add_fillet', featureId: 'fi1', edges: vertical, radius: 2 })).result.doc as PartDoc
    const top = await pick(rounded, { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } })
    const inward = await apply(rounded, { type: 'add_shell', featureId: 'sh1', faces: top, thickness: 2, direction: 'inward' })
    expect(inward.problem?.message).toContain('inward thickness 2 >= fillet radius 2')
    const outward = await apply(rounded, { type: 'add_shell', featureId: 'sh1', faces: top, thickness: 2, direction: 'outward' })
    expect(outward.problem).toBeUndefined()
  }, 120_000)
})
