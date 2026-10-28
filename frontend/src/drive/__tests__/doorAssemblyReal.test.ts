// @vitest-environment node
//
// The door example, abridged to its frame: the cube corner block plus the long
// and short rails, fixed to it with two face-to-face mates. Built over the
// headless ops in-process with the real OCC kernel and the real mate solver.
//
// The full door adds the panel and the handle on a hole axis and a seat plane.
// In the current mate solver that pair is rank-deficient with the panel's fixed
// mate (two mates constrain the same axis direction), so the solve reports
// overconstrained rather than the plan's underconstrained/dof 1. That is a mate
// solver verdict question, not a drive one, and the frame below is the part of
// the example this feature can pin. The mcp-practice re-run attempts the full
// door and files what it finds (feature/backlog.md).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'
import { buildAssemblyWorkspaceZip } from '../assemblyWorkspaceZip'
import { readZipTree } from '@/workspace/zipCarrier'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

function rectSketch(sketchId: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    id: sketchId, kind: 'sketch' as const, plane: '@builtin_plane_top',
    entities: [{ id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const }, { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const }],
    initial: { bottom: [x0, y0, x1, y0], right: [x1, y0, x1, y1], top: [x1, y1, x0, y1], left: [x0, y1, x0, y0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: x1 - x0 },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: y1 - y0 },
    ],
  }
}

function section(height: number): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      rectSketch('sk1', -10, -10, 10, 10),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: height, direction: 'normal', operation: 'new' } },
    ],
  } as unknown as PartDoc
}

const PARTS = new Map<string, PartDoc>([
  ['cube', section(20)],
  ['rail_400', section(400)],
  ['rail_200', section(200)],
])

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const STEPS: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'con_bl', part: 'cube', fixed: true } },
  { mutation: { type: 'add_part', handle: 'left', part: 'rail_400', position: [50, 50, 50] } },
  { mutation: { type: 'add_part', handle: 'bottom', part: 'rail_200', position: [50, 50, 50] } },
  { mutation: {
    type: 'add_mate', featureId: 'm_left', kind: 'fixed',
    ref_a: { part: 'con_bl', selector: FLAT([0, 1, 0], 'max') },
    ref_b: { part: 'left', selector: FLAT([0, 1, 0], 'min') },
    flip: true,
  } },
  { mutation: {
    type: 'add_mate', featureId: 'm_bottom', kind: 'fixed',
    ref_a: { part: 'con_bl', selector: FLAT([1, 0, 0], 'max') },
    ref_b: { part: 'bottom', selector: FLAT([0, 1, 0], 'min') },
    flip: true,
  } },
]

function expectBbox(actual: unknown, expected: number[], digits = 3): void {
  const bbox = actual as number[]
  expect(bbox).toHaveLength(expected.length)
  bbox.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits))
}

describeReal('the door example frame', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('fixes both rails to the corner block and measures the frame', async () => {
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    expect(result.ok, JSON.stringify(result.mates)).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    expect(result.solve.dof).toBe(0)

    const byHandle = new Map(result.instances.map(instance => [instance.handle, instance]))
    expect(byHandle.get('con_bl')!.position).toEqual([0, 0, 0])
    expect(byHandle.get('con_bl')!.quaternion).toEqual([0, 0, 0, 1])
    expect(byHandle.get('left')!.position[0]).toBeCloseTo(0, 3)
    expect(byHandle.get('left')!.position[1]).toBeCloseTo(20, 3)
    expect(byHandle.get('left')!.position[2]).toBeCloseTo(0, 3)
    // The bottom rail's start-face anchor lands on the block's +X face.
    expect(result.mateFrames.m_bottom.ref_b!.point[0]).toBeCloseTo(10, 3)
    expect(result.mateFrames.m_bottom.ref_b!.point[1]).toBeCloseTo(10, 3)

    const measured = await measureAssemblyHeadless(result.doc, PARTS)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(3)
    expect(measured!.measures.volume).toBeCloseTo(8000 + 160000 + 80000, 3)
    expectBbox(measured!.measures.bbox, [-10, 0, -10, 210, 420, 10])

    // No write-back: an inspect call returns the same handle and poses.
    const inspected = await runAssemblyHeadless({ doc: result.doc, parts: PARTS, steps: [] })
    expect(docHashOf(inspected.doc)).toBe(docHashOf(result.doc))
    expect(inspected.instances).toEqual(result.instances)

    // The zip hand-off carries the assembly and every part.
    const zip = await buildAssemblyWorkspaceZip({ doc: result.doc, parts: Object.fromEntries(PARTS) })
    const tree = await readZipTree(zip)
    expect(Object.values(tree.manifest.entries).filter(row => row.kind === 'document')).toHaveLength(4)
  }, 300_000)

  it('is deterministic: the same script twice yields the same hashes and poses', async () => {
    const first = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    const second = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    expect(docHashOf(first.doc)).toBe(docHashOf(second.doc))
    expect(second.instances).toEqual(first.instances)
  }, 300_000)
})
