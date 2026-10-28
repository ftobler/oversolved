// @vitest-environment node
//
// Real-kernel tests for the assembly measure/export helpers: one build per
// distinct part doc, one placed copy per instance, per-body ids prefixed with
// the instance handle, and a STEP that re-imports to the same volume and bbox.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import {
  assemblyBuildCountForTest,
  exportAssemblyLocally,
  measureAssemblyLocally,
  measureLocally,
  resetAssemblyBuildCountForTest,
  setSolveLocalsForTest,
} from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
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

/** The 10 mm cube doc, stamped with a stable spec id so the dedupe can key on it. */
function cubeSpec() {
  return {
    id: 'cube',
    features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' } },
    ],
  }
}

function identity(): Transform3D {
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** 90 degrees about Y, then +20 x and +10 z: the cube occupies x 20..30, z 0..10. */
function quarterTurn(): Transform3D {
  const h = Math.sin(Math.PI / 4)
  const c = Math.cos(Math.PI / 4)
  return { tx: 20, ty: 0, tz: 10, qx: 0, qy: h, qz: 0, qw: c }
}

function expectBbox(actual: unknown, expected: number[]): void {
  const bbox = actual as number[]
  expect(bbox).toHaveLength(expected.length)
  bbox.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6))
}

describeReal('assembly measure and export', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('builds a shared part doc once and measures each placed instance', async () => {
    resetAssemblyBuildCountForTest()
    const measure = await measureAssemblyLocally([
      { handle: 'a', spec: cubeSpec(), transform: identity() },
      { handle: 'b', spec: cubeSpec(), transform: quarterTurn() },
    ])
    expect(measure).not.toBeNull()
    expect(measure!.bodies).toBe(2)
    expect(measure!.volume).toBeCloseTo(2000, 6)
    expectBbox(measure!.bbox, [0, 0, 0, 30, 10, 10])
    expect(measure!.perBody.map(body => body.id)).toEqual(['a/body_ex1', 'b/body_ex1'])
    // The dedupe: two instances of one spec id build the part once.
    expect(assemblyBuildCountForTest()).toBe(1)
  }, 120_000)

  it('exports the placed compound as STEP that re-imports to the same measures', async () => {
    const bytes = await exportAssemblyLocally(
      [{ spec: cubeSpec(), transform: identity() }, { spec: cubeSpec(), transform: quarterTurn() }],
      { format: 'step' },
    )
    expect(bytes).not.toBeNull()
    expect(bytes!.byteLength).toBeGreaterThan(0)

    const files = new Map([['f1', bytes!]])
    const imported = await measureLocally(
      { id: 'imported', features: [{ id: 'imp1', kind: 'import_step', file_id: 'f1' }] },
      files,
    )
    expect(imported).not.toBeNull()
    expect(imported!.volume).toBeCloseTo(2000, 6)
    expectBbox(imported!.bbox, [0, 0, 0, 30, 10, 10])
  }, 180_000)

  it('exports STL bytes for the same compound', async () => {
    const bytes = await exportAssemblyLocally(
      [{ spec: cubeSpec(), transform: identity() }, { spec: cubeSpec(), transform: quarterTurn() }],
      { format: 'stl' },
    )
    expect(bytes).not.toBeNull()
    expect(bytes!.byteLength).toBeGreaterThan(84)
  }, 120_000)
})
