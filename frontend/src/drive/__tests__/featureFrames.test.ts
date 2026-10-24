// @vitest-environment node
//
// The frames a run/measure reply reports: a sketch on a face takes the face's
// centroid as origin and the normalToFrame axes, an add_plane feature reports
// the frame it built, and the measure reply carries the same map the run did.
// Real kernel for the geometry; the helper's filtering and rounding are pure.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { featureFrames } from '../featureFrames'
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

describe('featureFrames', () => {
  it('reports only sketch and plane features, rounded, and skips a refused one', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', entities: [] },
        { id: 'pl1', kind: 'plane', definition: { mode: 'offset' } },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1' },
        { id: 'sk2', kind: 'sketch', entities: [] },
      ],
    } as PartDoc
    const result = {
      sk1: {
        status: 'underconstrained',
        plane_transform: {
          rotation: [1, 0, 0, 0, Math.PI, 0, 0, 0, 1],
          origin: [0, 0, 0.1 + 0.2],
        },
      },
      pl1: {
        status: 'ok',
        plane: {
          origin: [0, 0, 5],
          x_axis: [Math.PI, 0, 0],
          y_axis: [0, 0, -1],
          normal: [0, 0, 1],
        },
      },
      ex1: {
        status: 'ok',
        // Not a frame-bearing kind: a transform on an extrude must not leak in.
        plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [9, 9, 9] },
      },
      sk2: { status: 'exception', exception: "plane 'pl2' did not resolve" },
    }
    expect(featureFrames(doc, result)).toEqual({
      sk1: {
        origin: [0, 0, 0.3],
        x_axis: [1, 0, 0],
        y_axis: [0, 3.141593, 0],
        normal: [0, 0, 1],
      },
      pl1: { origin: [0, 0, 5], x_axis: [3.141593, 0, 0], y_axis: [0, 0, -1], normal: [0, 0, 1] },
    })
  })

  it('returns an empty map without a document or a solve result', () => {
    expect(featureFrames(null, {})).toEqual({})
    expect(featureFrames({ version: 1, kind: 'part', features: [] }, null)).toEqual({})
  })
})

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
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10 } },
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
