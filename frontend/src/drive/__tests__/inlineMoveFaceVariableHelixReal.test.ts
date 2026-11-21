// @vitest-environment node
//
// The real-kernel half of the inline `add_move_face`, `add_variable` and
// `add_helix` forms: one call carrying the fields must build the feature the
// old add + setter sequence built. The helix case compares the document and
// the resolved curve against the four-setter build; the other two pin the
// built shape. The pure catalog and applier half is
// utils/__tests__/yamlMutations.inlineAddFields and
// drive/__tests__/inlineFeatureAdds.
import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function feature(doc: PartDoc | null, id: string): PartFeature {
  const found = doc?.features?.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`no feature '${id}' in the document`)
  return found
}

/** The solve row of one feature, or undefined when the reply omitted it. */
function rowMessage(features: readonly { id: string; message?: string }[] | null | undefined, id: string): string | undefined {
  return (features ?? []).find(row => row.id === id)?.message
}

describe.skipIf(!ready)('inline move_face, variable and helix adds (real OCC + Rust solver)', () => {
  async function boxBase(): Promise<PartDoc> {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    return built.doc!
  }

  // The 40 x 30 x 10 box, so a +5 move of its +X face adds 5 * 30 * 10.
  it('one-call add_move_face moves the +X face by its inline distance', async () => {
    const base = await boxBase()
    const plusX = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [1, 0, 0] }, { extreme: { axis: [1, 0, 0], side: 'max' } }] },
    }))!.queries
    expect(plusX).toHaveLength(1)

    const run = await runHeadless({
      doc: structuredClone(base),
      steps: [m({ type: 'add_move_face', featureId: 'mf1', faces: plusX, distance: 5 })],
    })
    expect(run.ok).toBe(true)
    expect(nonSketchProblems(run.features)).toEqual([])
    expect(feature(run.doc, 'mf1')).toMatchObject({
      kind: 'move_face',
      move_face: { faces: plusX, distance: 5 },
    })

    const measured = await measureHeadless(run.doc!)
    expect(measured!.measures.volume).toBeCloseTo(12000 + 1500, 3)
    expect(measured!.measures.bbox![3]).toBeCloseTo(45, 6)
  }, 120_000)

  // The box is replaced by a plain 40 x 30 rectangle here, so the variable is
  // the only thing the extrude reads.
  async function variableBase(): Promise<PartDoc> {
    const built = await runHeadless({
      doc: emptyDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
        m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] }),
      ],
    })
    expect(built.ok).toBe(true)
    return built.doc!
  }

  it('one-call add_variable feeds a later extrude expression', async () => {
    const base = await variableBase()
    const built = await runHeadless({
      doc: structuredClone(base),
      steps: [
        m({ type: 'add_variable', featureId: 'w', label: 'w', expression: '40' }),
        // add_extrude's inline distance is a number (its applier signature); the
        // expression reaches the extrude through the setter, which takes one.
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
        m({ type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 'w / 4' }),
      ],
    })
    expect(built.ok).toBe(true)
    expect(nonSketchProblems(built.features)).toEqual([])
    expect(feature(built.doc, 'w')).toMatchObject({ kind: 'variable', label: 'w', variable: { expression: '40' } })
    expect((await measureHeadless(built.doc!))!.measures.volume).toBeCloseTo(40 * 30 * 10, 3)

    // The same variable set to 80 after the fact rebuilds 20 high.
    const grown = await runHeadless({
      doc: built.doc!,
      steps: [m({ type: 'set_variable_field', featureId: 'w', field: 'expression', value: '80' })],
    })
    expect(grown.ok).toBe(true)
    expect((await measureHeadless(grown.doc!))!.measures.volume).toBeCloseTo(40 * 30 * 20, 3)
  }, 120_000)

  it('refuses an inline expression naming a later variable with the ordering message', async () => {
    const built = await runHeadless({
      doc: emptyDoc(),
      steps: [
        m({ type: 'add_variable', featureId: 'v1', label: 'a', expression: 'b + 1' }),
        m({ type: 'add_variable', featureId: 'v2', label: 'b', expression: '2' }),
      ],
    })
    expect(built.ok).toBe(true)
    expect(rowMessage(built.features, 'v1')).toBe(
      "expression: variable 'b' is defined after this feature (at index 1); move it up with reorder_features",
    )
  }, 120_000)

  // R10 on Top, extruded 20: the lateral face is the helix's cylinder. The
  // sketch sits on a plane offset 20 and extrudes back to y = 0, so the face's
  // low end is at the origin and a +2 offset lands the helix start at [10, 2, 0].
  async function r10Cylinder(): Promise<{ doc: PartDoc; face: string }> {
    const built = await runHeadless({
      doc: emptyDoc(),
      steps: [
        m({
          type: 'add_plane', featureId: 'pl1',
          definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 20 },
        }),
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@pl1' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 10] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 20, direction: 'reverse', operation: 'new' }),
      ],
    })
    expect(built.ok).toBe(true)
    const faces = (await selectHeadless(built.doc!, { kind: 'face', where: { type: 'cylinderface' } }))!.queries
    expect(faces).toHaveLength(1)
    return { doc: built.doc!, face: faces[0] }
  }

  it('one-call add_helix matches the four-setter build', async () => {
    const { doc, face } = await r10Cylinder()
    const oneCall = await runHeadless({
      doc: structuredClone(doc),
      steps: [m({
        type: 'add_helix', featureId: 'hx1', reference: face,
        mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
      })],
    })
    const multi = await runHeadless({
      doc: structuredClone(doc),
      steps: [
        m({ type: 'add_helix', featureId: 'hx1', reference: face }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'mode', value: 'pitch_turns' }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'pitch', value: 3 }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: 8 }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'offset', value: 2 }),
      ],
    })
    expect(oneCall.ok).toBe(true)
    expect(multi.ok).toBe(true)
    expect(feature(oneCall.doc, 'hx1')).toEqual(feature(multi.doc, 'hx1'))
    expect(oneCall.curves!.hx1).toEqual(multi.curves!.hx1)

    const curve = oneCall.curves!.hx1
    expect(curve.height).toBe(24)
    expect(curve.start).toEqual([10, 2, 0])
  }, 180_000)

  it('refuses an invalid inline value with the message the setter gives', async () => {
    const { doc: cylinder, face } = await r10Cylinder()
    const inlineHelix = await runHeadless({
      doc: structuredClone(cylinder),
      steps: [m({
        type: 'add_helix', featureId: 'hx1', reference: face, mode: 'pitch_turns', pitch: 3, turns: -1,
      })],
    })
    const setHelix = await runHeadless({
      doc: structuredClone(cylinder),
      steps: [
        m({ type: 'add_helix', featureId: 'hx1', reference: face }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: -1 }),
      ],
    })
    expect(rowMessage(inlineHelix.features, 'hx1')).toBeDefined()
    expect(rowMessage(inlineHelix.features, 'hx1')).toBe(rowMessage(setHelix.features, 'hx1'))
    expect(rowMessage(inlineHelix.features, 'hx1')).toContain('turns')

    const base = await boxBase()
    const plusX = (await selectHeadless(base, {
      kind: 'face',
      where: { and: [{ parallel: [1, 0, 0] }, { extreme: { axis: [1, 0, 0], side: 'max' } }] },
    }))!.queries
    const inlineMove = await runHeadless({
      doc: structuredClone(base),
      steps: [m({ type: 'add_move_face', featureId: 'mf1', faces: plusX, distance: 'nope' })],
    })
    const setMove = await runHeadless({
      doc: structuredClone(base),
      steps: [
        m({ type: 'add_move_face', featureId: 'mf1', faces: plusX, distance: 5 }),
        m({ type: 'set_move_face_field', featureId: 'mf1', field: 'distance', value: 'nope' }),
      ],
    })
    expect(rowMessage(inlineMove.features, 'mf1')).toBeDefined()
    expect(rowMessage(inlineMove.features, 'mf1')).toBe(rowMessage(setMove.features, 'mf1'))
    expect(rowMessage(inlineMove.features, 'mf1')).toContain('nope')
  }, 180_000)
})
