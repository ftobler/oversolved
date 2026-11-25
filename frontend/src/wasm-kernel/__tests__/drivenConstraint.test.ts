// @vitest-environment node
//
// A driven reference is a document row only: it must not add a row to the wire,
// and it must not move the solve. The first check is pure lowering; the second
// runs the real Rust solver so a skipped row cannot quietly change the DOF.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { partDocToSketches } from '../partDocToSketches'
import { loadSolver } from '../loadSolver'
import { solveSketch, setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { initGlobalRepo } from '@/kernel/query'

const solveBytes = loadSolver()

const feature = (extra: unknown[] = []): PartFeature => ({
  id: 'sk1',
  kind: 'sketch',
  plane: '@builtin_plane_front',
  entities: [{ id: 'l1', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0] },
  constraints: [
    { id: 'c_start', kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: '@builtin_origin' },
    { id: 'c_h', kind: 'horizontal', target: { entity: 'l1' } },
    { id: 'c_len', kind: 'length', target: { entity: 'l1' }, value: 10 },
    ...extra,
  ],
} as PartFeature)

const drive = (driven: boolean) => feature(driven
  ? [{ id: 'c_ref', kind: 'length', target: { entity: 'l1' }, value: 10, driven: true }]
  : [])

describe('partDocToSketches: driven dimensions', () => {
  it('lowers to the exact wire of the sketch without the driven row', () => {
    const plain = partDocToSketches([drive(false)])
    const withRef = partDocToSketches([drive(true)])
    expect(plain.sketches).toHaveLength(1)
    expect(withRef.sketches).toHaveLength(1)
    expect(withRef.sketches[0].sketch.constraints).toEqual(plain.sketches[0].sketch.constraints)
    expect(withRef.sketches[0].droppedConstraints).toHaveLength(0)
  })
})

describe.skipIf(!solveBytes)('solveSketch: a driven dimension leaves the solve alone', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  it('keeps the same dof and status, and publishes the measured render', () => {
    setSketchSolver(solveBytes!)
    const plain = solveSketch(drive(false) as unknown as Record<string, unknown>, initGlobalRepo(), {})
    const withRef = solveSketch(drive(true) as unknown as Record<string, unknown>, initGlobalRepo(), {})
    expect(withRef.status).toBe(plain.status)
    expect(withRef.dof).toBe(plain.dof)
    expect(withRef.dropped_constraints).toBeUndefined()
    expect(withRef.constraints?.c_ref).toMatchObject({ driven: true, residual: 0, render: { kind: 'dim_linear', value: 10 } })
  })

  it('is not counted as superfluous even where a driving twin would be', () => {
    setSketchSolver(solveBytes!)
    const withRef = solveSketch(
      feature([
        { id: 'c_len2', kind: 'length', target: { entity: 'l1' }, value: 10 },
        { id: 'c_ref', kind: 'length', target: { entity: 'l1' }, value: 10, driven: true },
      ]) as unknown as Record<string, unknown>, initGlobalRepo(), {},
    )
    const flagged = Object.entries(withRef.constraints ?? {}).filter(([, c]) => c.superfluous).map(([id]) => id)
    expect(flagged).toEqual(['c_len2'])
    expect(withRef.constraints?.c_ref?.superfluous).toBeUndefined()
  })
})
