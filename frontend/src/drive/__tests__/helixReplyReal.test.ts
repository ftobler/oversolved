// @vitest-environment node
//
// The real-kernel half of the helix placement report: a helix on a built
// cylinder reports its start, end and climb axis, `measure` repeats the same
// map, a later call still carries it, and a sweep whose profile sits on the
// reported start builds. The pure helper is featureCurves.test.ts; the kernel
// leaf's own placement is helixReal.test.ts.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { runReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'
import type { ScriptStep } from '../scriptRunner'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'
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
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// A cylinder on Front: 10 tall, radius 5, so the lateral face's axial span is
// 10 and the helix sits on radius 5.
const CYLINDER: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
  m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5] }),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
]

async function cylinderWithFace(): Promise<{ doc: PartDoc; face: string }> {
  const built = await runHeadless({ doc: emptyDriveDoc(), steps: CYLINDER })
  expect(built.ok).toBe(true)
  const faces = (await selectHeadless(built.doc!, {
    kind: 'face',
    where: { type: 'cylinderface' },
  }))!.queries
  expect(faces).toHaveLength(1)
  return { doc: built.doc!, face: faces[0] }
}

// The report's own round: pitch 2.5, starting one unit up the cylinder. The
// sweep control asks for a shorter helix so the pipe shell stays quick; the
// placement it consumes is the same one.
async function helixRun(turns = 2): Promise<Awaited<ReturnType<typeof runHeadless>>> {
  const { doc, face } = await cylinderWithFace()
  return runHeadless({
    doc,
    steps: [
      m({ type: 'add_helix', featureId: 'hx1', reference: face }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'pitch', value: 2.5 }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: turns }),
      m({ type: 'set_helix_field', featureId: 'hx1', field: 'offset', value: 1 }),
    ],
  })
}

describe.skipIf(!ready)('helix placement in the drive reply (real OCC + Rust solver)', () => {
  it('reports no curves key for a document with no helix', async () => {
    const empty = await runHeadless({ doc: emptyDriveDoc(), steps: [] })
    expect(empty.curves).toEqual({})
    expect(runReply(empty, false, new DocHandleStore())).not.toHaveProperty('curves')
    expect((await measureHeadless(emptyDriveDoc()))!.curves).toEqual({})
  }, 120_000)

  it('reports the rounded start, end and climb axis on the run reply', async () => {
    const run = await helixRun()
    expect(run.ok).toBe(true)
    expect(nonSketchProblems(run.features)).toEqual([])
    const curve = run.curves!.hx1
    // The face's own axis is the climb direction under the default `normal`.
    // OCC reports this cylinder's surface axis as -Z, so the helix climbs down
    // from the top of the face: start at z = 10 - 1, end two pitches lower.
    expect(curve.axis).toEqual([0, 0, -1])
    // The -Z climb starts at the face's high end and the x0 zero direction is
    // -Y (normalToFrame's -Z row), so the first point sits on that side.
    expect(curve.start).toEqual([0, -5, 9])
    expect(curve.end).toEqual([0, -5, 4])
    expect(curve.origin).toEqual([0, 0, 9])
    expect(curve.radius).toBe(5)
    expect(curve.pitch).toBe(2.5)
    expect(curve.turns).toBe(2)
    expect(curve.height).toBe(5)
    expect(curve.hand).toBe('right')
    // helixReal.test.ts owns the agreement with the registered @hx1/start,
    // @hx1/end and bare-id axis; this reply is the same values after rounding.

    const reply = runReply(run, false, new DocHandleStore())
    expect(reply.curves).toEqual(run.curves)
    // The display polyline stays out of the reply.
    expect(JSON.stringify(reply)).not.toContain('spline')
  }, 120_000)

  it('measure reports the same map the run that built it did', async () => {
    const run = await helixRun()
    await yieldToEventLoop()
    const measured = await measureHeadless(run.doc as PartDoc)
    expect(measured!.curves).toEqual(run.curves)
  }, 120_000)

  it('a later call still carries the map', async () => {
    const run = await helixRun()
    await yieldToEventLoop()
    const chained = await runHeadless({
      doc: run.doc as PartDoc,
      steps: [m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' })],
    })
    expect(chained.ok).toBe(true)
    expect(nonSketchProblems(chained.features)).toEqual([])
    // The chained call touched the new sketch, never the helix: a touched-only
    // map would hide the start exactly when the sweep that follows needs it.
    expect(chained.curves!.hx1).toEqual(run.curves!.hx1)
  }, 120_000)

  it('a sweep whose profile sits at the reported start builds', async () => {
    const run = await helixRun(0.5)
    // Take the point from the reply, not from the @hx1/start ref: this is the
    // number a caller has, and the sweep must build on it after rounding.
    const start = run.curves!.hx1.start
    await yieldToEventLoop()
    const chained = await runHeadless({
      doc: run.doc as PartDoc,
      steps: [
        m({
          type: 'add_plane',
          featureId: 'pl1',
          definition: {
            mode: 'origin_rotation',
            origin: start,
            plane: '@builtin_plane_front',
            rotation_axis: 'z',
            rotation_angle: 0,
          },
        }),
        m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
        m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, 0.75] }),
        m({ type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk2', pathQuery: '@hx1' }),
      ],
    })
    expect(chained.ok).toBe(true)
    expect(nonSketchProblems(chained.features)).toEqual([])
    // The sweep defaults to `add`, so it grows the cylinder body rather than
    // minting body_sw1; the volume is the proof that it actually swept.
    expect(chained.bodies).toEqual(['body_ex1'])
    await yieldToEventLoop()
    const volume = (await measureHeadless(chained.doc as PartDoc))!.measures.volume
    // The plain cylinder is 785.398; the swept half turn adds material on top.
    expect(volume).toBeGreaterThan(785.5)
    // Still whole on the call that consumed the start.
    expect(chained.curves!.hx1).toEqual(run.curves!.hx1)
  }, 180_000)
})
