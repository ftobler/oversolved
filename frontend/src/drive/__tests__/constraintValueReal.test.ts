// @vitest-environment node
//
// A dimension value must survive storage on the document grid: a 5/16 inch
// bore (diameter 0.3125) used to store 0.313 because the constraint writers
// rounded to 1e-3, a fit-class error with no warning. This is the repro from
// the mcp-practice hex-nut run measured through the real kernel, in inch and
// millimetre documents. The appliers' own grid is pinned in
// utils/__tests__/yamlMutations.constraints.test.ts; this checks the number
// reaches the solver, not only the document.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

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

// The authored circle starts at radius 0.15 (inch) or 1 (mm); the diameter
// constraint is what drives it to the fractional value under test.
function boreSteps(unit: 'inch' | 'mm', diameter: number, radius: number): ScriptStep[] {
  const unitStep: ScriptStep[] = unit === 'inch'
    ? [{ mutation: { type: 'set_length_unit', unit: 'inch' } }]
    : []
  return [
    ...unitStep,
    { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Bore', plane: '@builtin_plane_top' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, radius], entityId: 'c1' } },
    // The repro's target spelling: a select query naming the circle by id.
    { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'diameter', targets: ['$c1'], value: diameter } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Bore', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
  ]
}

function storedDiameter(doc: PartDoc): number | undefined {
  const sketch = doc.features?.find(feature => feature.id === 'sk1')
  if (sketch?.kind !== 'sketch') return undefined
  return sketch.constraints?.find(constraint => constraint.kind === 'diameter')?.value
}

// The acute angle between two solved line segments, in degrees. abs folds the
// supplement (157.5) onto the authored 22.5, since either satisfies the solver.
function acuteLineAngle(a: number[], b: number[]): number {
  const ax = a[2] - a[0]
  const ay = a[3] - a[1]
  const bx = b[2] - b[0]
  const by = b[3] - b[1]
  const cos = Math.abs(ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))
  return Math.acos(Math.min(1, cos)) * 180 / Math.PI
}

const ready = oc && solveBytes

describe.skipIf(!ready)('a dimension value is stored on the 1e-6 grid (real OCC + Rust solver)', () => {
  it('keeps a 5/16 inch bore at radius 0.15625', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: boreSteps('inch', 0.3125, 0.15),
      featureDeltas: 'all',
    })
    expect(result.ok).toBe(true)
    expect(result.doc?.length_unit).toBe('inch')
    expect(result.features).toEqual([])
    expect(storedDiameter(result.doc!)).toBe(0.3125)

    const extrude = result.featureDeltas?.find(row => row.id === 'ex1')
    expect(extrude?.bbox).not.toBeNull()
    // The Top plane's normal is Y, so the disc spans X/Z and the extrude Y.
    const expected = [-0.15625, 0, -0.15625, 0.15625, 1, 0.15625]
    extrude!.bbox!.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9))
  }, 120_000)

  it('keeps a 2.0625 mm bore at radius 1.03125', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: boreSteps('mm', 2.0625, 1),
      featureDeltas: 'all',
    })
    expect(result.ok).toBe(true)
    expect(result.doc?.length_unit).toBeUndefined()
    expect(result.features).toEqual([])
    expect(storedDiameter(result.doc!)).toBe(2.0625)

    const extrude = result.featureDeltas?.find(row => row.id === 'ex1')
    expect(extrude?.bbox).not.toBeNull()
    const expected = [-1.03125, 0, -1.03125, 1.03125, 1, 1.03125]
    extrude!.bbox!.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9))
  }, 120_000)

  it('solves an angle constraint of 22.5 to 22.5 degrees', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Angle', plane: '@builtin_plane_top' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10, 0], entityId: 'l1' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10, 10], entityId: 'l2' } },
        { mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'angle', targets: ['$l1', '$l2'], value: 22.5 } },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    // The solve writes the baked params into `initial`; the angle is the
    // grid-only regression guard for the storage change.
    const sketch = result.doc?.features?.find(feature => feature.id === 'sk1')
    if (sketch?.kind !== 'sketch') throw new Error('unreachable')
    expect(acuteLineAngle(sketch.initial!.l1, sketch.initial!.l2)).toBeCloseTo(22.5, 4)
  }, 120_000)
})
