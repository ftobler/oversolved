// @vitest-environment node
//
// The bug-1 trapezoid of the mcp-practice drawing run, rebuilt as a cut into a
// 9 x 2.5 x 4 block. Its stored line directions make both wall corners theta
// 135, while the corner a person reads on the drawing is the supplement, 45.
// An `angle` mutation's value is now that read number, so typing 45 must store
// 135 and leave the authored walls where they are; before the change the solver
// satisfied 45 by swinging each wall outward and the cut measured 0.45 in3 too
// large. The 135 spelling (what the old document stored) must still mean theta.
// Real OCC + Rust solver, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import type { Mutation } from '@/types/cad'
import { featureById } from '@/testing/featureAccess'
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

// The cradles plus the slot of the practice run, in inches. The block's top
// edge is y = 2.5, so each cradle circle removes a half disc through the 4 in
// depth; the slot is a 4 in bottom, 3 in top, 0.5 in deep trapezoid.
const CUT_VOLUME = 2 * Math.PI * (0.75 ** 2 + 1.25 ** 2) + 1.75 * 4

function slotSteps(value: number, sign?: number): ScriptStep[] {
  const m = (mutation: Mutation): ScriptStep => ({ mutation })
  const fixedToOrigin = (vertex: string, x: number, y: number): ScriptStep[] => [
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_x', targets: ['@builtin_origin', vertex], value: x, sign: 1 }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_y', targets: ['@builtin_origin', vertex], value: y, sign: 1 }),
  ]
  const angle = (a: string, b: string): ScriptStep => m({
    type: 'add_constraint', featureId: 'sk2', kind: 'angle',
    targets: [`entity:sk2:${a}`, `entity:sk2:${b}`],
    value,
    ...(sign !== undefined ? { sign } : {}),
  })
  return [
    m({ type: 'set_length_unit', unit: 'inch' }),
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [9, 2.5], p0Ref: '@builtin_origin', dimensions: true }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 4, operation: 'new' }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [1.75, 2.5, 0.75], entityId: 'c1' }),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [7.25, 2.5, 1.25], entityId: 'c2' }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'radius', targets: ['entity:sk2:c1'], value: 0.75 }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'radius', targets: ['entity:sk2:c2'], value: 1.25 }),
    ...fixedToOrigin('vertex:sk2:c1:center', 1.75, 2.5),
    ...fixedToOrigin('vertex:sk2:c2:center', 7.25, 2.5),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'line', params: [2.5, 0, 6.5, 0], entityId: 'l1' }),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'line', params: [6.5, 0, 6, 0.5], entityId: 'l2' }),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'line', params: [6, 0.5, 3, 0.5], entityId: 'l3' }),
    m({ type: 'add_entity', featureId: 'sk2', kind: 'line', params: [3, 0.5, 2.5, 0], entityId: 'l4' }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'coincident', targets: ['vertex:sk2:l1:end', 'vertex:sk2:l2:start'] }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'coincident', targets: ['vertex:sk2:l2:end', 'vertex:sk2:l3:start'] }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'coincident', targets: ['vertex:sk2:l3:end', 'vertex:sk2:l4:start'] }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'coincident', targets: ['vertex:sk2:l4:end', 'vertex:sk2:l1:start'] }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'horizontal', targets: ['entity:sk2:l3'] }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'length', targets: ['entity:sk2:l1'], value: 4 }),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'length', targets: ['entity:sk2:l3'], value: 3 }),
    ...fixedToOrigin('vertex:sk2:l1:start', 2.5, 0),
    angle('l1', 'l2'),
    angle('l4', 'l1'),
    m({ type: 'add_constraint', featureId: 'sk2', kind: 'line_distance', targets: ['entity:sk2:l1', 'vertex:sk2:l3:start'], value: 0.5 }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 4, termination: 'through_all', operation: 'cut' }),
  ]
}

const sketchOf = (doc: PartDoc): SketchFeature => featureById(doc, 'sk2', 'sketch')

function cutVolume(result: HeadlessRunResult): number {
  const row = result.featureDeltas?.find(entry => entry.id === 'ex2')
  if (!row) throw new Error('the reply carried no ex2 delta row')
  return Math.abs(row.volumeDelta)
}

describe.skipIf(!ready)('an angle value is the corner the label shows (real OCC + Rust solver)', () => {
  it('authors 45 on the 135-degree walls, keeps them authored, and cuts the right slot', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: slotSteps(45), featureDeltas: 'all' })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.part.solveOutcomes().sk2.status).toBe('fully_constrained')
    expect(cutVolume(result)).toBeCloseTo(CUT_VOLUME, 4)

    const sketch = sketchOf(result.doc!)
    // The walls stayed where they were authored; the old raw-value reading
    // swung l2's end out to (7.01, 0.497) and l4's start to (2.17, 0.497).
    expect(sketch.initial!.l2[2]).toBeCloseTo(6, 4)
    expect(sketch.initial!.l2[3]).toBeCloseTo(0.5, 4)
    expect(sketch.initial!.l4[0]).toBeCloseTo(3, 4)
    expect(sketch.initial!.l4[1]).toBeCloseTo(0.5, 4)

    const angles = sketch.constraints!.filter(c => c.kind === 'angle')
    expect(angles).toHaveLength(2)
    for (const angle of angles) {
      expect(angle.value).toBe(135)
      expect(angle.pos).toBeDefined()
    }
  }, 240_000)

  it('the 135 spelling stores theta and cuts the identical slot', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: slotSteps(135), featureDeltas: 'all' })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.part.solveOutcomes().sk2.status).toBe('fully_constrained')
    expect(cutVolume(result)).toBeCloseTo(CUT_VOLUME, 4)
    const sketch = sketchOf(result.doc!)
    expect(sketch.initial!.l2[2]).toBeCloseTo(6, 4)
    expect(sketch.initial!.l4[0]).toBeCloseTo(3, 4)
    for (const angle of sketch.constraints!.filter(c => c.kind === 'angle')) {
      expect(angle.value).toBe(135)
      expect(angle.pos).toBeUndefined()
    }
  }, 240_000)

  it('a signed 45 keeps the drawn handedness instead of flipping the wall', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: slotSteps(45, 1), featureDeltas: 'all' })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.part.solveOutcomes().sk2.status).toBe('fully_constrained')
    expect(cutVolume(result)).toBeCloseTo(CUT_VOLUME, 4)
    const sketch = sketchOf(result.doc!)
    expect(sketch.initial!.l2[2]).toBeCloseTo(6, 4)
    expect(sketch.initial!.l4[0]).toBeCloseTo(3, 4)
    for (const angle of sketch.constraints!.filter(c => c.kind === 'angle')) {
      expect(angle.value).toBe(135)
      expect(angle.sign).toBe(1)
    }
  }, 240_000)
})
