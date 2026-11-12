// @vitest-environment node
//
// The headless route for the mixed-unit assembly: a `kind: "assembly"` run plus
// a `measure`, the two calls the CLI and the MCP `run`/`measure` tools share
// through `headlessOps`. The assembly frame is millimetres; the metric cube
// stores 25.4 and the imperial cube stores 1 (inch), and both must land as the
// same 25.4 mm cube.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const SIDE_MM = 25.4
const UNIT_VOLUME = SIDE_MM ** 3

/** A fully constrained square on the Front plane, pinned to `@builtin_origin`. */
function squareSketch(sketchId: string, side: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Square', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, side, 0], right: [side, 0, side, side],
      top: [side, side, 0, side], left: [0, side, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: side },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: side },
      { id: 'c11', kind: 'point_distance_x' as const, a: { entity: 'bottom', point: 'start' as const }, b: '@builtin_origin', value: 0, sign: -1 },
      { id: 'c12', kind: 'point_distance_y' as const, a: { entity: 'bottom', point: 'start' as const }, b: '@builtin_origin', value: 0, sign: -1 },
    ],
  }
}

function cubeDoc(side: number, unit?: 'inch'): PartDoc {
  return {
    version: 1,
    kind: 'part',
    ...(unit === 'inch' ? { length_unit: unit } : {}),
    features: [
      squareSketch('sk1', side),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: side, direction: 'normal', operation: 'new' } },
    ],
  } as PartDoc
}

const PARTS = new Map<string, PartDoc>([
  ['metric', cubeDoc(SIDE_MM)],
  ['inch', cubeDoc(1, 'inch')],
])

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const STEPS: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'metric', part: 'metric', fixed: true } },
  { mutation: { type: 'add_part', handle: 'inch', part: 'inch', position: [40, 40, 40] } },
  {
    mutation: {
      type: 'add_mate', featureId: 'm1', kind: 'fixed',
      ref_a: { part: 'metric', selector: FLAT([0, 0, 1], 'max') },
      ref_b: { part: 'inch', selector: FLAT([0, 0, 1], 'min') },
      flip: true,
      // The faces' canonical roll frames are half a turn apart, so 180 degrees
      // is the authored angle that lands the square faces flush.
      angle: 180,
    },
  },
]

describeReal('headless mixed-unit assembly', () => {
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

  it('runs the assembly and measures both cubes at their physical 25.4 mm size', async () => {
    const run = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: PARTS,
      steps: STEPS,
    })
    expect(run.ok).toBe(true)
    expect(run.mates).toEqual([])
    expect(run.solve.verdict).toBe('fully_constrained')

    const inch = run.instances.find(instance => instance.handle === 'inch')!
    expect(inch.position[0]).toBeCloseTo(0, 5)
    expect(inch.position[1]).toBeCloseTo(0, 5)
    expect(inch.position[2]).toBeCloseTo(SIDE_MM, 5)

    const measured = await measureAssemblyHeadless(run.doc, PARTS)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.measures.bodies).toBe(2)
    expect(measured!.measures.volume).toBeCloseTo(2 * UNIT_VOLUME, 4)
    measured!.measures.bbox!.forEach((value, i) => {
      expect(value).toBeCloseTo([0, 0, 0, SIDE_MM, SIDE_MM, 2 * SIDE_MM][i], 5)
    })
    expect(measured!.measures.perBody.map(body => body.volume)).toEqual([
      expect.closeTo(UNIT_VOLUME, 4),
      expect.closeTo(UNIT_VOLUME, 4),
    ])
  }, 240_000)
})
