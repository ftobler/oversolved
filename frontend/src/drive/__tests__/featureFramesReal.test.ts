// @vitest-environment node
//
// The real-kernel half of the frame report: a sketch on a face takes the face's
// centroid as origin and the normalToFrame axes, and an add_plane feature
// reports the frame it built. The helper's filtering and rounding are pinned
// without a kernel in featureFrames.test.ts.

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
import { nonSketchProblems } from './buildProblems'

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
describe.skipIf(!ready)('feature frames (real OCC + Rust solver)', () => {
  it('reports a sketch on a +Y face at the face centroid with the normalToFrame axes', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(built.ok).toBe(true)
    // The box's own sketch sits on Top: the builtin's axes, not Front's.
    expect(built.frames!.sk1).toEqual({
      origin: [0, 0, 0],
      x_axis: [1, 0, 0],
      y_axis: [0, 0, -1],
      normal: [0, 1, 0],
    })

    const faces = (await selectHeadless(built.doc!, {
      kind: 'face',
      where: { and: [{ parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)
    const onFace = await runHeadless({
      doc: built.doc!,
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: faces[0] } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [4, 4] } },
      ],
    })
    expect(onFace.ok).toBe(true)
    expect(onFace.frames!.sk2).toEqual({
      // 40x30 on Top extruded 10: the +Y face is centred at y=10, z=-15.
      origin: [20, 10, -15],
      x_axis: [1, 0, 0],
      y_axis: [0, 0, -1],
      normal: [0, 1, 0],
    })
  }, 120_000)

  it('reports a sketch on a +Z face with x->+Y, the frame the sketch uses', async () => {
    // Built on Front so its topside is +Z: this is the case the practice runs
    // hit, and the axes are a quarter turn against the Front plane's own.
    const built = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
      ],
    })
    expect(built.ok).toBe(true)
    const faces = (await selectHeadless(built.doc!, {
      kind: 'face',
      where: { and: [{ parallel: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)
    const onFace = await runHeadless({
      doc: built.doc!,
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: faces[0] } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [4, 4] } },
      ],
    })
    expect(onFace.ok).toBe(true)
    expect(onFace.frames!.sk2).toEqual({
      origin: [20, 15, 10],
      x_axis: [0, 1, 0],
      y_axis: [-1, 0, 0],
      normal: [0, 0, 1],
    })
  }, 120_000)

  it('reports an add_plane offset with the parent plane axes', async () => {
    const built = await runHeadless({
      doc: emptyDoc(),
      steps: [{
        mutation: {
          type: 'add_plane',
          featureId: 'pl1',
          definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 },
        },
      }],
    })
    expect(built.ok).toBe(true)
    expect(built.frames!.pl1).toEqual({
      origin: [0, 0, 5],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
      normal: [0, 0, 1],
    })
  }, 120_000)

  it('measure reports the same frames as the run that built the document', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.frames).toEqual(built.frames)
  }, 120_000)

  it('reports only the frames a chained run touched, and frames: "all" restores the rest', async () => {
    const authored = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [4, 4] } },
      ],
    })
    expect(authored.ok).toBe(true)
    expect(Object.keys(authored.frames!).sort()).toEqual(['sk1', 'sk2'])

    // A fillet touches no sketch or plane: both earlier frames are unchanged.
    const filleted = await runHeadless({
      doc: authored.doc!,
      steps: [
        { mutation: { type: 'add_fillet', featureId: 'f1', label: 'Fillet' } },
        { mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?body_ex1:edge:0' } },
      ],
    })
    expect(filleted.ok).toBe(true)
    expect(filleted.frames).toEqual({})

    // The save-only case from the report: steps: [] reports no frames either.
    const saved = await runHeadless({ doc: filleted.doc!, steps: [] })
    expect(saved.frames).toEqual({})

    // The explicit inspection path restores every resolved frame.
    const all = await runHeadless({ doc: filleted.doc!, steps: [], frames: 'all' })
    expect(Object.keys(all.frames!).sort()).toEqual(['sk1', 'sk2'])
    // The two opt-ins are independent: asking for every frame still filters the
    // delta rows, and asking for every delta row still filters the frames.
    expect(all.featureDeltas).toEqual([])
    const allDeltas = await runHeadless({ doc: filleted.doc!, steps: [], featureDeltas: 'all' })
    expect(allDeltas.frames).toEqual({})
    expect(allDeltas.featureDeltas!.map(row => row.id).sort()).toEqual(['ex1', 'f1', 'sk1', 'sk2'])

    // measure is the measurement call: it keeps every resolved frame.
    const measured = await measureHeadless(filleted.doc!)
    expect(measured).not.toBeNull()
    expect(Object.keys(measured!.frames).sort()).toEqual(['sk1', 'sk2'])
  }, 240_000)

  it('names two sketches on one face query once a feature between them moved the face', async () => {
    // ANC101 F2: sk8 sits on the canted face, a boss removes part of that face,
    // and sk9 is drawn on the same stored query. Each sketch is internally
    // consistent, but the pair is 0.12 mm apart and the bore would be eccentric.
    const plate = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
      ],
    })
    expect(plate.ok).toBe(true)
    const faces = (await selectHeadless(plate.doc!, {
      kind: 'face',
      where: { and: [{ parallel: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
    }))!.queries
    expect(faces).toHaveLength(1)

    // A boss off the face centre consumes area from the face, so its centroid
    // (the plane origin) moves before the bore sketch is drawn.
    const boss = await runHeadless({
      doc: plate.doc!,
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: faces[0] } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [5, 0, 3] } },
        { mutation: { type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 3, operation: 'add' } },
      ],
    })
    expect(boss.ok).toBe(true)
    expect(boss.frames!.sk2).toBeDefined()

    const bore = await runHeadless({
      doc: boss.doc!,
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk3', plane: faces[0] } },
        { mutation: { type: 'add_entity', featureId: 'sk3', kind: 'circle', params: [5, 0, 1] } },
      ],
    })
    expect(bore.ok).toBe(true)
    expect(nonSketchProblems(bore.features)).toEqual([])
    expect(bore.notes).toHaveLength(1)
    expect(bore.notes[0].ids).toEqual(['sk2', 'sk3'])
    expect(bore.notes[0].text).toContain(`sk2 and sk3 share the face query "${faces[0]}"`)
    expect(bore.notes[0].text).toMatch(/their resolved origins differ by 0\.\d+ mm/)
    // The run touched only sk3, so the reply's changed-only filter drops sk2;
    // the conflict was still found in the full frames map before that filter.
    expect(Object.keys(bore.frames ?? {})).toEqual(['sk3'])

    // A measure resolves the same pair, so it reports the same conflict, and
    // its frames map holds both origins the note compares.
    const measured = await measureHeadless(bore.doc!)
    expect(measured!.notes).toEqual(bore.notes)
    expect(measured!.frames.sk3!.origin).not.toEqual(measured!.frames.sk2!.origin)
  }, 120_000)
})
