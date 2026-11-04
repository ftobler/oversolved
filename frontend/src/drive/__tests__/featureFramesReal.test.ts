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
})
