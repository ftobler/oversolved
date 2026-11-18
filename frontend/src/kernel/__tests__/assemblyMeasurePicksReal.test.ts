// @vitest-environment node
//
// The assembly's kernel cells, answered by rebuilding and placing each named
// part on the OCC worker. These are the numbers the anchor/bundle path cannot
// state analytically: a whole-instance volume, an instance-to-instance
// clearance, and an edge length read through the same render-index contract the
// part editor uses.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import {
  measureAssemblyPicksLocally,
  measurePicksLocally,
  setSolveLocalsForTest,
} from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { handleMeasureAssemblyRequest } from '../worker/solverWorker'
import type { Transform3D } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()
const describeReal = oc && solveBytes ? describe : describe.skip

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

/** The 10 mm cube, stamped with a stable spec id so the build dedupe can key on it. */
function cubeSpec() {
  return {
    id: 'cube',
    features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' } },
    ],
  }
}

function translate(x: number, y = 0, z = 0): Transform3D {
  return { tx: x, ty: y, tz: z, qx: 0, qy: 0, qz: 0, qw: 1 }
}

describeReal('measureAssemblyPicksLocally', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('reads two whole instances 10 apart as a clearance of 10', async () => {
    const read = await measureAssemblyPicksLocally(
      [
        { handle: 'a', spec: cubeSpec(), transform: translate(0) },
        { handle: 'b', spec: cubeSpec(), transform: translate(20) },
      ],
      'clearance',
      [{ handle: 'a', kind: 'body' }, { handle: 'b', kind: 'body' }],
    )
    expect(read).toMatchObject({ ok: true, value: 10 })
  }, 120_000)

  it('reads overlapping and touching instances as 0 with the reason named', async () => {
    const overlapping = await measureAssemblyPicksLocally(
      [
        { handle: 'a', spec: cubeSpec(), transform: translate(0) },
        { handle: 'b', spec: cubeSpec(), transform: translate(5) },
      ],
      'clearance',
      [{ handle: 'a', kind: 'body' }, { handle: 'b', kind: 'body' }],
    )
    expect(overlapping).toMatchObject({ ok: true, value: 0, note: 'overlapping' })

    const touching = await measureAssemblyPicksLocally(
      [
        { handle: 'a', spec: cubeSpec(), transform: translate(0) },
        { handle: 'b', spec: cubeSpec(), transform: translate(10) },
      ],
      'clearance',
      [{ handle: 'a', kind: 'body' }, { handle: 'b', kind: 'body' }],
    )
    expect(touching).toMatchObject({ ok: true, value: 0, note: 'touching' })
  }, 180_000)

  it('reads a whole instance volume', async () => {
    const read = await measureAssemblyPicksLocally(
      [{ handle: 'a', spec: cubeSpec(), transform: translate(0) }],
      'volume',
      [{ handle: 'a', kind: 'body' }],
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value).toBeCloseTo(1000, 6)
    expect(read.extra?.[0]).toMatchObject({ kind: 'area' })
    expect(read.extra?.[0].value).toBeCloseTo(600, 6)
  }, 120_000)

  // The bundle and this rebuild both walk the same deterministic spec, so a
  // render index must name the same element. A drift here measures a neighbour,
  // which no readout would look wrong.
  it('resolves a face index to the same face the part editor measures', async () => {
    const part = await measurePicksLocally(cubeSpec(), ['@body_ex1/face/0'])
    const assembly = await measureAssemblyPicksLocally(
      [{ handle: 'a', spec: cubeSpec(), transform: translate(0) }],
      'area',
      [{ handle: 'a', partIndex: 0, kind: 'face', index: 0 }],
    )
    expect(part).not.toBeNull()
    expect(assembly).toMatchObject({ ok: true, value: part!.value })
  }, 120_000)

  it('resolves an edge index to the same edge the part editor measures', async () => {
    const part = await measurePicksLocally(cubeSpec(), ['@body_ex1/edge/0'])
    const assembly = await measureAssemblyPicksLocally(
      [{ handle: 'a', spec: cubeSpec(), transform: translate(0) }],
      'length',
      [{ handle: 'a', partIndex: 0, kind: 'edge', index: 0 }],
    )
    expect(part).not.toBeNull()
    expect(assembly).toMatchObject({ ok: true, value: part!.value })
  }, 120_000)

  it('reads a body that is not in the request as unresolved', async () => {
    expect(await measureAssemblyPicksLocally(
      [{ handle: 'a', spec: cubeSpec(), transform: translate(0) }],
      'volume',
      [{ handle: 'ghost', kind: 'body' }],
    )).toMatchObject({ ok: false })
  }, 60_000)
})

describe('handleMeasureAssemblyRequest', () => {
  it('maps the engine answer onto the wire reply', async () => {
    const reply = await handleMeasureAssemblyRequest(
      { id: 7, kind: 'measureAssembly', parts: [], op: 'clearance', picks: [] },
      async () => ({ ok: true, value: 10, note: 'touching', extra: [{ kind: 'area', value: 2, label: 'area' }] }),
    )
    expect(reply).toEqual({
      id: 7, ok: true, value: 10, note: 'touching', extra: [{ kind: 'area', value: 2, label: 'area' }],
    })
  })

  it('maps a refusal to an error reply instead of a value', async () => {
    const reply = await handleMeasureAssemblyRequest(
      { id: 8, kind: 'measureAssembly', parts: [], op: 'distance', picks: [] },
      async () => ({ ok: false, error: 'measure unresolved' }),
    )
    expect(reply).toEqual({ id: 8, ok: false, error: 'measure unresolved' })
  })
})
