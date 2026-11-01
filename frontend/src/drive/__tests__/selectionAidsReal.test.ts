// @vitest-environment node
//
// The real-kernel half of selector picks in `add_sketch.plane` /
// `set_feature_plane.plane` and `add_shell.faces`: the headless drive resolves
// the `select` selector against the settled solve and stores the query string,
// so an agent does not paste a long `?...` string per sketch (batch B
// friction). This half proves the one-step path, the chained run's first-step
// solve, and the refusals; the synthetic-input half is selectionAids.test.ts.

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
describe.skipIf(!ready)('selector picks through the headless drive (real OCC)', () => {
  it('places a sketch on the selector face in one step and stores the query', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    // The selector is resolved against a solve of the starting document, which
    // this run has not done yet: the drive solves once before the first step.
    const oneStep = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_sketch', featureId: 'sk2', label: 'On face',
        plane: { selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } },
      })],
    })
    expect(oneStep.ok).toBe(true)
    const sketch = oneStep.doc?.features?.find(feature => feature.id === 'sk2')
    expect(sketch?.kind === 'sketch' ? sketch.plane : undefined).toBe(faces[0])
    expect(oneStep.frames?.sk2).toBeDefined()
  }, 240_000)

  it('moves an existing sketch onto a selector face in one step', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    const moved = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'set_feature_plane', featureId: 'sk1',
        plane: { selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } },
      })],
    })
    expect(moved.ok).toBe(true)
    const sketch = moved.doc?.features?.find(feature => feature.id === 'sk1')
    expect(sketch?.kind === 'sketch' ? sketch.plane : undefined).toBe(faces[0])
  }, 240_000)

  it('refuses a plane selector matching both the top and bottom face, naming the count', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)

    const refused = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [step({
        type: 'add_sketch', featureId: 'sk2',
        plane: { selector: { kind: 'face', where: { parallel: [0, 1, 0] } } },
      })],
    })
    expect(refused.ok).toBe(false)
    expect(refused.outcome.steps[0].error?.message).toContain('exactly one face')
  }, 240_000)

  it('opens a shell with a face selector, matching the explicit query string', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    const base = built.doc!
    const faces = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    const bySelector = await runHeadless({
      doc: structuredClone(base),
      steps: [step({
        type: 'add_shell', featureId: 'sh1', label: 'Shell',
        faces: [{ selector: { kind: 'face', where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] } } }],
        thickness: 1, direction: 'inward',
      })],
    })
    const byQuery = await runHeadless({
      doc: structuredClone(base),
      steps: [step({ type: 'add_shell', featureId: 'sh1', label: 'Shell', faces, thickness: 1, direction: 'inward' })],
    })
    expect(bySelector.ok).toBe(true)
    expect(byQuery.ok).toBe(true)
    expect(bySelector.doc?.features?.find(feature => feature.id === 'sh1'))
      .toEqual(byQuery.doc?.features?.find(feature => feature.id === 'sh1'))
    const one = await measureHeadless(bySelector.doc!)
    const two = await measureHeadless(byQuery.doc!)
    expect(one!.measures.volume).toBeCloseTo(two!.measures.volume, 9)
  }, 240_000)
})
