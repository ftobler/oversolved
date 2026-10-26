// @vitest-environment node
//
// A boolean `tools` entry that names an array feature expands to the array's
// source body and every instance body at solve time, so a later count change
// is followed (sprocket F3 typed 40 ids by hand; din_rail F1 raised a count
// and left the new slots floating free). A hand list that names only some of
// one array's bodies warns. The add_boolean / add_extrude inline fields carry
// the whole feature in one call. Real kernel, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { mutationInfoOf } from '../mutationCatalog'
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
const ca = (field: string, value: unknown) => m({ type: 'set_circular_array_field', featureId: 'ca1', field, value })

const PLATE = 100 * 100 * 10
const SLOT = 6 * 6 * 10

// A 100 x 100 x 10 plate, a 6 x 6 slot tool fully inside it off the Y axis,
// and a `new` circular array of the tool about +Y, each step one inline call.
function arraySteps(count: number): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [-50, -50], p1: [50, 50] }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' }),
    m({ type: 'add_rect', featureId: 'sk2', p0: [20, -3], p1: [26, 3] }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 10, operation: 'new' }),
    m({ type: 'add_circular_array', featureId: 'ca1' }),
    ca('source_body', 'body_ex2'),
    ca('operation', 'new'),
    ca('count', count),
    ca('axis_origin', [0, 0, 0]),
    ca('axis_direction', [0, 1, 0]),
  ]
}

describe('add_boolean / add_extrude inline catalog rows', () => {
  it('publish the inline fields, the required boolean fields and the array-tool rule', () => {
    const boolean = mutationInfoOf('add_boolean')
    for (const key of ['operation', 'target', 'tools']) expect(boolean.fields[key], key).toBeDefined()
    expect(boolean.note).toContain('needs `target`')
    expect(boolean.note).toContain('@<arrayId>')
    const extrude = mutationInfoOf('add_extrude')
    for (const key of ['direction', 'operation', 'merge_target']) expect(extrude.fields[key], key).toBeDefined()
  })
})

describe.skipIf(!ready)('boolean tools naming an array feature (real OCC + Rust solver)', () => {
  it('subtracts every instance and follows a later count change', async () => {
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...arraySteps(6),
        m({ type: 'add_boolean', featureId: 'bo1', operation: 'subtract', target: 'body_ex1', tools: ['@ca1'] }),
      ],
    })
    expect(built.features).toEqual([])
    const six = await measureHeadless(built.doc as PartDoc)
    expect(six!.measures.bodies).toBe(1)
    expect(six!.measures.volume).toBeCloseTo(PLATE - 6 * SLOT, 3)

    const raised = await runHeadless({ doc: built.doc as PartDoc, steps: [ca('count', 8)] })
    expect(raised.features).toEqual([])
    const eight = await measureHeadless(raised.doc as PartDoc)
    expect(eight!.measures.bodies).toBe(1)
    expect(eight!.measures.volume).toBeCloseTo(PLATE - 8 * SLOT, 3)
  }, 120_000)

  it('refuses by name an array defined after the boolean instead of consuming its bare source', async () => {
    const steps = arraySteps(6)
    const boolean = m({ type: 'add_boolean', featureId: 'bo1', operation: 'subtract', target: 'body_ex1', tools: ['@ca1'] })
    // Same features, the boolean inserted above the array.
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: [...steps.slice(0, 6), boolean, ...steps.slice(6)] })
    const problem = built.features.find(feature => feature.id === 'bo1')
    expect(problem?.message).toContain("body not found for ref '@ca1'")
  }, 120_000)

  it('warns when a hand list names only some of one array\'s bodies', async () => {
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        ...arraySteps(6),
        m({ type: 'add_boolean', featureId: 'bo1', operation: 'subtract', target: 'body_ex1', tools: ['body_ex2', 'body_ca1'] }),
      ],
    })
    const problem = built.features.find(feature => feature.id === 'bo1')
    expect(problem?.message).toContain('array ca1 has 6 instances, the boolean uses 2')
  }, 120_000)
})
