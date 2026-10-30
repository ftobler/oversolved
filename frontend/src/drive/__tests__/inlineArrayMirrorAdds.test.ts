// @vitest-environment node
//
// The bulk `add_array` / `add_circular_array` / `add_mirror` forms: one call
// carrying the source, counts, pitches, axis or plane must land the same
// document as the old feature + one setter per field sequence. The practice
// round paid seven calls for a one-line linear array (batch B F2).

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'
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

describe('add_array / add_circular_array / add_mirror inline fields', () => {
  it('publishes the inline fields and the one-call note', () => {
    const array = mutationInfoOf('add_array')
    for (const field of ['source_body', 'mode', 'operation', 'count_x', 'pitch_x', 'direction_x_query', 'invert_x']) {
      expect(array.fields[field], field).toBeDefined()
    }
    expect(array.note).toContain('One call may carry the whole array')
    expect(array.note).toContain('set_array_field')

    const circular = mutationInfoOf('add_circular_array')
    for (const field of ['source_body', 'operation', 'count', 'step_angle', 'axis', 'axis_origin', 'axis_direction']) {
      expect(circular.fields[field], field).toBeDefined()
    }
    expect(circular.note).toContain('One call may carry the whole array')
    expect(circular.note).toContain('set_circular_array_field')

    const mirror = mutationInfoOf('add_mirror')
    for (const field of ['body', 'plane', 'keep_original', 'merge']) {
      expect(mirror.fields[field], field).toBeDefined()
    }
    expect(mirror.note).toContain('set_mirror_field')
  })
})

describe('inline field application', () => {
  it('keeps a rectangular count_y expression instead of seeding the default', () => {
    const doc = emptyDoc()
    mutationHandlers.add_array(doc, {
      type: 'add_array', featureId: 'ar1', mode: 'rectangular',
      count_x: 2, pitch_x: 20, count_y: 'n', pitch_y: 'p',
    })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature).toMatchObject({
      kind: 'array',
      array: { mode: 'rectangular', count_y: 'n', pitch_y: 'p' },
    })
  })

  it('clears a default on an explicit empty value, like the setter does', () => {
    const doc = emptyDoc()
    mutationHandlers.add_array(doc, { type: 'add_array', featureId: 'ar1', count_x: '' })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature?.kind === 'array' ? feature.array.count_x : 'missing').toBeUndefined()
  })

  it('accepts a null step_angle and stores no key for it', () => {
    const mutation = { type: 'add_circular_array', featureId: 'ca1', step_angle: null }
    expect(validateMutation(mutation).ok).toBe(true)
    const doc = emptyDoc()
    mutationHandlers.add_circular_array(doc, { ...mutation } as never)
    const feature = doc.features?.find(entry => entry.id === 'ca1')
    expect(feature?.kind === 'circular_array' ? feature.circular_array.step_angle : 'missing').toBeUndefined()
  })
})

describe.skipIf(!ready)('inline array and mirror adds (real OCC + Rust solver)', () => {
  async function boxBase(): Promise<PartDoc> {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    return built.doc!
  }

  it('one-call linear array matches the feature + six setters by document and volume', async () => {
    const base = await boxBase()
    const direction = (await selectHeadless(base, { kind: 'edge', where: { parallel: [1, 0, 0] } }))!.queries[0]
    expect(direction).toBeDefined()

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_array', featureId: 'ar1', label: 'Array',
        source_body: 'body_ex1', operation: 'new', count_x: 3, pitch_x: 60,
        direction_x_query: direction, invert_x: true,
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_array', featureId: 'ar1', label: 'Array' }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'source_body', value: 'body_ex1' }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'operation', value: 'new' }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'count_x', value: 3 }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'pitch_x', value: 60 }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'direction_x_query', value: direction }),
        step({ type: 'set_array_field', featureId: 'ar1', field: 'invert_x', value: true }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ar1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ar1')
    expect(oneFeature).toEqual(multiFeature)
    expect(oneFeature).toMatchObject({
      kind: 'array',
      array: {
        source_body: 'body_ex1', operation: 'new', count_x: 3, pitch_x: 60,
        direction_x_query: direction, invert_x: true,
      },
    })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
    // Two extra copies of the 12000 mm3 box, one pitch apart.
    expect(one!.measures.volume).toBeCloseTo(36000, 6)
  }, 240_000)

  it('one-call circular array matches the feature + setters by document and volume', async () => {
    const base = await boxBase()
    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_circular_array', featureId: 'ca1', label: 'Circular',
        source_body: 'body_ex1', operation: 'new', count: 6, step_angle: 60,
        axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_circular_array', featureId: 'ca1', label: 'Circular' }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'source_body', value: 'body_ex1' }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'operation', value: 'new' }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'count', value: 6 }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'step_angle', value: 60 }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'axis_origin', value: [0, 0, 0] }),
        step({ type: 'set_circular_array_field', featureId: 'ca1', field: 'axis_direction', value: [0, 1, 0] }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ca1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ca1')
    expect(oneFeature).toEqual(multiFeature)
    expect(oneFeature).toMatchObject({
      kind: 'circular_array',
      circular_array: { source_body: 'body_ex1', operation: 'new', count: 6, step_angle: 60 },
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
