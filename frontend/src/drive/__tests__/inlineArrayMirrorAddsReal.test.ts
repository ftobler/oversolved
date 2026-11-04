// @vitest-environment node
//
// The real-kernel half of the bulk `add_pattern` / `add_mirror` forms: one call
// carrying the source, counts, pitches, axis or plane must land the same
// document as the old feature + one setter per field sequence. The pure catalog
// and document-shape half is inlineArrayMirrorAdds.test.ts.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
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
function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
describe.skipIf(!ready)('inline pattern and mirror adds (real OCC + Rust solver)', () => {
  async function boxBase(): Promise<PartDoc> {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    return built.doc!
  }

  it('one-call linear pattern matches the feature + six setters by document and volume', async () => {
    const base = await boxBase()
    const direction = (await selectHeadless(base, { kind: 'edge', where: { parallel: [1, 0, 0] } }))!.queries[0]
    expect(direction).toBeDefined()

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_pattern', featureId: 'ar1', label: 'Pattern', subject: 'body',
        source_body: 'body_ex1', operation: 'new', mode: 'linear', count: 3, pitch: 60,
        direction_query: direction, invert: true,
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_pattern', featureId: 'ar1', label: 'Pattern' }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'source_body', value: 'body_ex1' }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'operation', value: 'new' }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'count', value: 3 }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'pitch', value: 60 }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'direction_query', value: direction }),
        step({ type: 'set_pattern_field', featureId: 'ar1', field: 'invert', value: true }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ar1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ar1')
    expect(oneFeature).toEqual(multiFeature)
    expect(oneFeature).toMatchObject({
      kind: 'pattern',
      pattern: {
        subject: 'body', source_body: 'body_ex1', operation: 'new', mode: 'linear',
        count: 3, pitch: 60, direction_query: direction, invert: true,
      },
    })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
    // Two extra copies of the 12000 mm3 box, one pitch apart.
    expect(one!.measures.volume).toBeCloseTo(36000, 6)
  }, 240_000)

  it('one-call circular pattern matches the feature + setters by document and volume', async () => {
    const base = await boxBase()
    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_pattern', featureId: 'ca1', label: 'Circular', subject: 'body', mode: 'circular',
        source_body: 'body_ex1', operation: 'new', count: 6, step_angle: 60,
        axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_pattern', featureId: 'ca1', label: 'Circular' }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'mode', value: 'circular' }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'source_body', value: 'body_ex1' }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'operation', value: 'new' }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'count', value: 6 }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'step_angle', value: 60 }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'axis_origin', value: [0, 0, 0] }),
        step({ type: 'set_pattern_field', featureId: 'ca1', field: 'axis_direction', value: [0, 1, 0] }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ca1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ca1')
    expect(oneFeature).toEqual(multiFeature)
    expect(oneFeature).toMatchObject({
      kind: 'pattern',
      pattern: {
        subject: 'body', mode: 'circular', source_body: 'body_ex1',
        operation: 'new', count: 6, step_angle: 60,
      },
    })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)

  it('one-call mirror matches the feature + three setters by document and volume', async () => {
    const base = await boxBase()
    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_mirror', featureId: 'mi1', label: 'Mirror',
        body: 'body_ex1', plane: '@builtin_plane_right', keep_original: false, merge: false,
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_mirror', featureId: 'mi1', label: 'Mirror' }),
        step({ type: 'set_mirror_field', featureId: 'mi1', field: 'body', value: 'body_ex1' }),
        step({ type: 'set_mirror_field', featureId: 'mi1', field: 'plane', value: '@builtin_plane_right' }),
        step({ type: 'set_mirror_field', featureId: 'mi1', field: 'keep_original', value: false }),
        step({ type: 'set_mirror_field', featureId: 'mi1', field: 'merge', value: false }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'mi1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'mi1')
    expect(oneFeature).toEqual(multiFeature)
    expect(oneFeature).toMatchObject({
      kind: 'mirror',
      mirror: { body: 'body_ex1', plane: '@builtin_plane_right', keep_original: false, merge: false },
    })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)
})
