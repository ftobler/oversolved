// @vitest-environment node
//
// The real-kernel half of the bulk `add_chamfer` / `add_shell` forms: one call
// carrying the pick list and the parameter must produce the same solid as the
// old feature + pick + field sequence. The practice round paid 6 and 4 calls
// for what `add_fillet` already did in one. The pure catalog row and shell sign
// note are inlineFeatureAdds.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { featureById } from '@/testing/featureAccess'
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
function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
const ready = oc && solveBytes
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)
describe.skipIf(!ready)('inline chamfer and shell (real OCC + Rust solver)', () => {
  it('one-call chamfer matches the feature + edge + field sequence by volume', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const queries = (await selectHeadless(base, { kind: 'edge', where: { parallel: [0, 1, 0] } }))!.queries
    expect(queries.length).toBeGreaterThan(0)
    const edge = queries[0]

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer', edges: [edge], distance: 2 })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer' }),
        step({ type: 'add_chamfer_edge', featureId: 'ch1', edgeQuery: edge }),
        step({ type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 2 }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'ch1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'ch1')
    expect(oneFeature).toMatchObject({ kind: 'chamfer', chamfer: { edges: [edge], distance: 2 } })
    expect(multiFeature).toMatchObject({ kind: 'chamfer', chamfer: { edges: [edge], distance: 2 } })
    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one).not.toBeNull()
    expect(many).not.toBeNull()
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)

  it('one-call two_distance chamfer stores and builds its kind, second leg and reverse', async () => {    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const queries = (await selectHeadless(base, { kind: 'edge', where: { parallel: [0, 1, 0] } }))!.queries
    const edge = queries[0]
    for (const reverse of [false, true]) {
      const call = await runHeadless({
        doc: structuredClone(base),
        steps: [step({
          type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer', edges: [edge],
          distance: 1, kind: 'two_distance', distance2: 2, ...(reverse ? { reverse: true } : {}),
        })],
      })
      expect(call.ok).toBe(true)
      expect(featureById(call.doc!, 'ch1', 'chamfer')).toMatchObject({
        chamfer: { distance: 1, kind: 'two_distance', distance2: 2, ...(reverse ? { reverse: true } : {}) },
      })
      const measured = await measureHeadless(call.doc!)
      expect(measured).not.toBeNull()
      // The picked edge is 10 long: 0.5 * 1 * 2 * 10 removed from 12000, on
      // whichever of the two faces the first leg lands on.
      expect(measured!.measures.volume).toBeCloseTo(11990, 6)
    }
  }, 240_000)

  it('evaluates an expression distance2 on a two_distance add', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const queries = (await selectHeadless(base, { kind: 'edge', where: { parallel: [0, 1, 0] } }))!.queries
    const edge = queries[0]
    const run = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_variable', featureId: 'w', label: 'w', expression: '2' }),
        step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer', edges: [edge], distance: 1, kind: 'two_distance', distance2: 'w' }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(nonSketchProblems(run.features)).toEqual([])
    // The document keeps the expression; the solve evaluates it.
    expect(featureById(run.doc!, 'ch1', 'chamfer')).toMatchObject({ chamfer: { distance: 1, kind: 'two_distance', distance2: 'w' } })
    expect((await measureHeadless(run.doc!))!.measures.volume).toBeCloseTo(12000 - 0.5 * 1 * 2 * 10, 6)
  }, 240_000)

  it('switching an expression-distance chamfer to two_distance builds red-free', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const queries = (await selectHeadless(base, { kind: 'edge', where: { parallel: [0, 1, 0] } }))!.queries
    const edge = queries[0]
    // The kind switch seeds distance2 from the raw distance expression. Before
    // distance2 was expression-capable that seeded string reached the kernel
    // unevaluated and the feature went red.
    const run = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_variable', featureId: 'w', label: 'w', expression: '2' }),
        step({ type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer', edges: [edge], distance: 'w' }),
        step({ type: 'set_chamfer_field', featureId: 'ch1', field: 'kind', value: 'two_distance' }),
      ],
    })
    expect(run.ok).toBe(true)
    expect(nonSketchProblems(run.features)).toEqual([])
    expect(featureById(run.doc!, 'ch1', 'chamfer')).toMatchObject({
      chamfer: { distance: 'w', kind: 'two_distance', distance2: 'w' },
    })
    // Both legs evaluate to 2: 0.5 * 2 * 2 * 10 removed.
    expect((await measureHeadless(run.doc!))!.measures.volume).toBeCloseTo(12000 - 20, 6)
  }, 240_000)

  it('one-call shell matches the feature + face + field sequence by volume', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)
    const face = faces[0]

    const oneCall = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_shell', featureId: 'sh1', label: 'Shell', faces: [face], thickness: 1, direction: 'inward' })],
    })
    const multi = await runHeadless({
      doc: structuredClone(base),
      steps: [
        step({ type: 'add_shell', featureId: 'sh1', label: 'Shell' }),
        step({ type: 'add_shell_face', featureId: 'sh1', faceQuery: face }),
        step({ type: 'set_shell_field', featureId: 'sh1', field: 'thickness', value: 1 }),
        step({ type: 'set_shell_field', featureId: 'sh1', field: 'direction', value: 'inward' }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)

    const oneFeature = oneCall.doc?.features?.find(feature => feature.id === 'sh1')
    const multiFeature = multi.doc?.features?.find(feature => feature.id === 'sh1')
    expect(oneFeature).toMatchObject({ kind: 'shell', shell: { faces: [face], thickness: 1, direction: 'inward' } })
    expect(multiFeature).toMatchObject({ kind: 'shell', shell: { faces: [face], thickness: 1, direction: 'inward' } })

    const one = await measureHeadless(oneCall.doc!)
    const many = await measureHeadless(multi.doc!)
    expect(one).not.toBeNull()
    expect(many).not.toBeNull()
    expect(one!.measures.volume).toBeCloseTo(many!.measures.volume, 9)
  }, 240_000)

  it('carries add_shell join arc through the dispatch table and the kernel', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    const face = faces[0]
    const shell = (join?: 'arc') => runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_shell', featureId: 'sh1', label: 'Shell', faces: [face],
        thickness: 0.05, direction: 'outward', ...(join === undefined ? {} : { join }),
      })],
    })
    const arc = await shell('arc')
    const sharp = await shell()
    expect(arc.ok).toBe(true)
    expect(sharp.ok).toBe(true)
    expect(featureById(arc.doc!, 'sh1', 'shell')).toMatchObject({
      kind: 'shell', shell: { join: 'arc', direction: 'outward' },
    })
    expect(featureById(sharp.doc!, 'sh1', 'shell').shell).not.toHaveProperty('join')
    // The rounded corners remove the corner prisms from an outward shell.
    const arcMeasure = await measureHeadless(arc.doc!)
    const sharpMeasure = await measureHeadless(sharp.doc!)
    expect(arcMeasure).not.toBeNull()
    expect(sharpMeasure).not.toBeNull()
    expect(arcMeasure!.measures.volume).toBeLessThan(sharpMeasure!.measures.volume)
  }, 240_000)
})
