// @vitest-environment node
//
// The real-kernel half of selector picks on every body-pick field: each kind of
// covered field (a face list, a single face, a vertex, an edge, a plane
// definition field and a setter value) resolves against the settled solve to the
// same document a pasted `select` query builds. The refusals keep the field name
// and the select engine's nearest-miss wording. The catalog and boundary half is
// selectorPickFields.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { loadOcc, occInstalled } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'
import { nonSketchProblems } from './buildProblems'

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function example(name: string): ScriptStep[] {
  return MUTATION_EXAMPLES.find(entry => entry.name === name)!.steps
}

async function baseDoc(name: string): Promise<PartDoc> {
  const built = await runHeadless({ doc: emptyDoc(), steps: example(name) })
  expect(built.ok).toBe(true)
  return built.doc!
}

const TOP_FACE_SELECTOR = {
  kind: 'face',
  where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
}

describe.skipIf(!ready)('selectors on every covered pick field (real OCC)', () => {
  it('deletes the four fillet faces by selector and heals the box to 12000', async () => {
    const base = await baseDoc('filleted-box')
    const queries = (await selectHeadless(base, { kind: 'face', where: { created_by: 'fi1' } }))!.queries
    expect(queries).toHaveLength(4)

    const selector = { kind: 'face', where: { created_by: 'fi1' } }
    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_delete_face', featureId: 'df1', label: 'Delete Face', faces: [{ selector }] })],
    })
    const byQuery = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_delete_face', featureId: 'df1', label: 'Delete Face', faces: queries })],
    })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(nonSketchProblems(bySelector.features)).toEqual([])
    expect(bySelector.doc?.features?.find(feature => feature.id === 'df1'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'df1'))
    const feature = bySelector.doc?.features?.find(candidate => candidate.id === 'df1')
    expect(feature?.kind).toBe('delete_face')
    if (feature?.kind !== 'delete_face') return
    expect(feature.delete_face.faces).toEqual(queries)
    expect(feature.delete_face.faces.every(face => typeof face === 'string')).toBe(true)
    expect((await measureHeadless(bySelector.doc!))!.measures.volume).toBeCloseTo(12000, 3)
  }, 240_000)

  it('wraps onto the one cylinder face a selector names, and the cut variant removes 98.75', async () => {
    const wrapSteps = example('wrap-on-cylinder')
    const base = (await runHeadless({ doc: emptyDoc(), steps: wrapSteps.slice(0, -1) })).doc!
    const queries = (await selectHeadless(base, { kind: 'face', where: { type: 'cylinderface' } }))!.queries
    expect(queries).toHaveLength(1)
    const baseVolume = (await measureHeadless(base))!.measures.volume

    const selector = { kind: 'face', where: { type: 'cylinderface' } }
    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', label: 'Wrap', sketchQuery: '$sk2',
        target: { selector }, height: 0.5, operation: 'add',
      })],
    })
    const byQuery = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', label: 'Wrap', sketchQuery: '$sk2',
        target: queries[0], height: 0.5, operation: 'add',
      })],
    })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(nonSketchProblems(bySelector.features)).toEqual([])
    expect(bySelector.doc?.features?.find(feature => feature.id === 'wr1'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'wr1'))
    const stored = bySelector.doc?.features?.find(candidate => candidate.id === 'wr1')
    expect(stored?.kind).toBe('wrap')
    if (stored?.kind !== 'wrap') return
    expect(stored.wrap.target).toBe(queries[0])

    const cut = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', label: 'Wrap', sketchQuery: '$sk2',
        target: { selector }, height: 0.5, operation: 'cut',
      })],
    })
    expect(cut.ok).toBe(true)
    const cutVolume = (await measureHeadless(cut.doc!))!.measures.volume
    expect(baseVolume - cutVolume).toBeCloseTo(98.75, 2)
  }, 240_000)

  it('extrudes up to the top face a selector names, equal to the pasted query build', async () => {
    const base = await baseDoc('box')
    const queries = (await selectHeadless(base, TOP_FACE_SELECTOR))!.queries
    expect(queries).toHaveLength(1)
    // A 10 x 10 boss beside the box, so the up_to stop is the box's own top and
    // the new part's volume depends only on the resolved height.
    const steps = (upTo: unknown): ScriptStep[] => [
      step({ type: 'add_sketch', featureId: 'sk2', label: 'Boss', plane: '@builtin_plane_top' }),
      step({
        type: 'add_rect', featureId: 'sk2', p0: [50, -10], p1: [60, 0],
        p0Ref: '@builtin_origin', dimensions: true,
      }),
      step({
        type: 'add_extrude', featureId: 'ex2', label: 'Boss',
        sketchQuery: '$sk2', distance: 1, operation: 'new', termination: 'up_to', up_to: upTo,
      }),
    ]
    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: steps({ selector: TOP_FACE_SELECTOR }),
    })
    const byQuery = await runHeadless({ doc: structuredClone(base), steps: steps(queries[0]) })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(nonSketchProblems(bySelector.features)).toEqual([])
    expect(bySelector.doc?.features?.find(feature => feature.id === 'ex2'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'ex2'))
    const feature = bySelector.doc?.features?.find(candidate => candidate.id === 'ex2')
    expect(feature?.kind).toBe('extrude')
    if (feature?.kind !== 'extrude') return
    expect(feature.extrude.up_to).toBe(queries[0])
  }, 240_000)

  it('places an on_face plane from a selector face, matching the pasted query frame', async () => {
    const base = await baseDoc('box')
    const queries = (await selectHeadless(base, TOP_FACE_SELECTOR))!.queries
    expect(queries).toHaveLength(1)
    const definition = (face: unknown) => ({ mode: 'on_face', face })
    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_plane', featureId: 'pl1', label: 'On face', definition: definition({ selector: TOP_FACE_SELECTOR }) })],
    })
    const byQuery = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_plane', featureId: 'pl1', label: 'On face', definition: definition(queries[0]) })],
    })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(nonSketchProblems(bySelector.features)).toEqual([])
    expect(bySelector.doc?.features?.find(feature => feature.id === 'pl1'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'pl1'))
    expect(bySelector.frames?.pl1).toEqual(byQuery.frames?.pl1)
  }, 240_000)

  it('sets a covered setter field from a selector, storing the resolved query', async () => {
    const wrapSteps = example('wrap-on-cylinder')
    const base = (await runHeadless({ doc: emptyDoc(), steps: wrapSteps.slice(0, -1) })).doc!
    const queries = (await selectHeadless(base, { kind: 'face', where: { type: 'cylinderface' } }))!.queries
    const built = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', label: 'Wrap', sketchQuery: '$sk2',
        target: queries[0], height: 0.5,
      })],
    })
    expect(built.ok).toBe(true)

    // The wrap's own wall is a cylinder face too, so narrow by the face the
    // extrude made; the setter must store the query that one resolves to.
    const selector = { kind: 'face', where: { and: [{ type: 'cylinderface' }, { created_by: 'ex1' }] } }
    const afterBuild = (await selectHeadless(built.doc!, selector))!
    expect(afterBuild.queries).toHaveLength(1)
    const moved = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({
        type: 'set_wrap_field', featureId: 'wr1', field: 'target', value: { selector },
      })],
    })
    expect(moved.ok).toBe(true)
    const stored = moved.doc?.features?.find(candidate => candidate.id === 'wr1')
    expect(stored?.kind).toBe('wrap')
    if (stored?.kind !== 'wrap') return
    expect(stored.wrap.target).toBe(afterBuild.queries[0])
  }, 240_000)

  it('refuses a wrap target matching two faces, naming the field and the count', async () => {
    const wrapSteps = example('wrap-on-cylinder')
    const base = (await runHeadless({ doc: emptyDoc(), steps: wrapSteps.slice(0, -1) })).doc!
    const refused = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', sketchQuery: '$sk2',
        target: { selector: { kind: 'face', where: { type: 'flatface' } } }, height: 0.5,
      })],
    })
    expect(refused.ok).toBe(false)
    const message = refused.outcome.steps[0].error?.message ?? ''
    expect(message).toContain('add_wrap target')
    expect(message).toContain('matched 2 items')
    expect(message).toContain('exactly one face')
  }, 240_000)

  it('keeps the select nearest-miss wording for a wrap target matching nothing', async () => {
    const wrapSteps = example('wrap-on-cylinder')
    const base = (await runHeadless({ doc: emptyDoc(), steps: wrapSteps.slice(0, -1) })).doc!
    const refused = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_wrap', featureId: 'wr1', sketchQuery: '$sk2',
        target: { selector: { kind: 'face', where: { type: 'sphereface' } } }, height: 0.5,
      })],
    })
    expect(refused.ok).toBe(false)
    const message = refused.outcome.steps[0].error?.message ?? ''
    expect(message).toContain('add_wrap target')
    expect(message).toContain('matched no faces')
    expect(message).toContain('sphereface')
  }, 240_000)
})
