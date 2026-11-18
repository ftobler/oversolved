// @vitest-environment node
//
// The MCP `measure between` answer for an assembly: two instance picks, resolved
// through the same pure core the viewport HUD uses and, for a kernel cell, from
// a rebuild of only the instances the picks name.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { measureAssemblyBetweenHeadless } from '@/drive/headlessOps'
import { emptyDriveAssemblyDoc } from '@/drive/headlessAssembly'
import type { AssemblyDoc, PartDoc, Transform3D } from '@/types/cad'

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

/** The 10 mm cube as a part document. */
function cubeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' } },
    ],
  } as unknown as PartDoc
}

function translate(x: number): Transform3D {
  return { tx: x, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

/** Two instances of one cube, the second 20 mm along x. */
function assemblyDoc(): AssemblyDoc {
  const doc = emptyDriveAssemblyDoc()
  const features = doc.features ?? (doc.features = [])
  features.push(
    {
      id: 'inst_a', kind: 'part_instance',
      instance: { handle: 'a', doc_id: 'cube', doc_rev: 1, transform: translate(0), visible: true, fixed: false },
    },
    {
      id: 'inst_b', kind: 'part_instance',
      instance: { handle: 'b', doc_id: 'cube', doc_rev: 1, transform: translate(20), visible: true, fixed: false },
    },
  )
  return doc
}

describeReal('measureAssemblyBetweenHeadless', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('answers an instance clearance and a single-instance volume from entity keys', async () => {
    const parts = new Map([['cube', cubeDoc()]])

    const clearance = await measureAssemblyBetweenHeadless(assemblyDoc(), parts, [
      'a|0|body|0',
      'b|0|body|0',
    ])
    expect(clearance).toMatchObject({ kind: 'clearance', value: 10 })

    const volume = await measureAssemblyBetweenHeadless(assemblyDoc(), parts, ['a|0|body|0'])
    expect(volume).toMatchObject({ kind: 'volume' })
    expect(volume!.value).toBeCloseTo(1000, 6)
  }, 180_000)

  it('refuses a selection that states no measurement', async () => {
    await expect(measureAssemblyBetweenHeadless(
      assemblyDoc(),
      new Map([['cube', cubeDoc()]]),
      ['a|0|body|0', 'ghost'],
    )).rejects.toThrow('states no measurement')
  }, 120_000)
})
