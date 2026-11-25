// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import { redundantWithoutConstraint } from '@/kernel/features/constraintProbe'
import { overconstrainReason } from '@/utils/core/constraintRefusals'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { displayedDimensionValue } from '@/utils/geometry/dimensionMeasure'
import { computeAngleDimension } from '@/utils/geometry/angleDimensionLogic'
import type { DimAngleRender } from '@/types/cad'

const solveBytes = loadSolver()

beforeAll(() => resetSketchSolver())
afterAll(() => resetSketchSolver())

const doc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{
    id: 'sk1',
    kind: 'sketch',
    entities: [{ id: 'l1', kind: 'line' }],
    initial: { l1: [0, 0, 10, 0] },
    constraints: [{ id: 'c_len', kind: 'length', target: '$l1', value: 10 }],
  }],
} as unknown as PartDoc)

const row = (d: PartDoc, id = 'c_len') =>
  ((d.features?.[0] as { constraints?: Array<{ id: string; driven?: true; value?: number }> })?.constraints ?? [])
    .find(c => c.id === id)

describe('driven dimension mutations', () => {
  it('add_constraint refuses driven on a geometric kind by name', () => {
    expect(() => mutationHandlers.add_constraint(doc(), {
      type: 'add_constraint', featureId: 'sk1', kind: 'parallel',
      targets: ['entity:sk1:l1', 'entity:sk1:l2'], driven: true,
    })).toThrow(MutationRefusal)
    expect(() => mutationHandlers.add_constraint(doc(), {
      type: 'add_constraint', featureId: 'sk1', kind: 'parallel',
      targets: ['entity:sk1:l1', 'entity:sk1:l2'], driven: true,
    })).toThrow(/parallel cannot be driven/)
  })

  it('add_constraint authors driven on a dimension kind', () => {
    const d = doc()
    mutationHandlers.add_constraint(d, {
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x',
      targets: ['vertex:sk1:l1:start', '@builtin_origin'], value: 3, sign: 1, driven: true,
    })
    const added = ((d.features?.[0] as { constraints?: Array<{ kind: string; driven?: true }> })?.constraints ?? [])
      .find(c => c.kind === 'point_distance_x')
    expect(added?.driven).toBe(true)
  })

  it('set_constraint_driven round trips and the driving step writes the measured value', () => {
    const d = doc()
    mutationHandlers.set_constraint_driven(d, {
      type: 'set_constraint_driven', featureId: 'sk1', constraintId: 'c_len', driven: true, value: 10,
    })
    expect(row(d)).toMatchObject({ driven: true, value: 10 })
    mutationHandlers.set_constraint_driven(d, {
      type: 'set_constraint_driven', featureId: 'sk1', constraintId: 'c_len', driven: false, value: 12.5,
    })
    expect(row(d)?.driven).toBeUndefined()
    expect(row(d)?.value).toBe(12.5)
  })

  it('an un-drive writes the displayed supplement, not raw theta', () => {
    // The context menu reads the solved render. An angle in a supplement wedge
    // shows 180 - theta; the applier converts that back to theta against the
    // stored pos. Passing raw theta would store the supplement and move it.
    const p1: [number, number] = [0, 0]
    const p2: [number, number] = [10, 0]
    const p3: [number, number] = [0, 0]
    const p4: [number, number] = [5, 5 * Math.tan(Math.PI / 3)]
    const theta = 60
    const pos: [number, number] = [3 * Math.cos(2 * Math.PI / 3), 3 * Math.sin(2 * Math.PI / 3)]
    expect(computeAngleDimension(p1, p2, p3, p4, pos).isSupplement).toBe(true)
    const render: DimAngleRender = { kind: 'dim_angle', p1, p2, p3, p4, value: theta, pos }
    expect(displayedDimensionValue(render)).toBeCloseTo(120, 6)

    const d = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
        initial: { l1: p1.concat(p2), l2: p3.concat(p4) },
        constraints: [],
      }],
    } as unknown as PartDoc
    mutationHandlers.add_constraint(d, {
      type: 'add_constraint', featureId: 'sk1', kind: 'angle',
      targets: ['entity:sk1:l1', 'entity:sk1:l2'], value: displayedDimensionValue(render)!, pos,
    })
    mutationHandlers.set_constraint_driven(d, {
      type: 'set_constraint_driven', featureId: 'sk1',
      constraintId: ((d.features?.[0] as { constraints?: Array<{ id: string; kind: string }> })?.constraints ?? [])
        .find(c => c.kind === 'angle')!.id,
      driven: false,
      value: displayedDimensionValue(render)!,
    })
    const angle = ((d.features?.[0] as { constraints?: Array<{ kind: string; value?: number }> })?.constraints ?? [])
      .find(c => c.kind === 'angle')!
    expect(angle.value).toBeCloseTo(theta, 6)
  })

  it('set_constraint_driven refuses a non-dimension row by name', () => {
    const d = doc()
    mutationHandlers.add_constraint(d, {
      type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'],
    })
    const horizontal = ((d.features?.[0] as { constraints?: Array<{ id: string; kind: string }> })?.constraints ?? [])
      .find(c => c.kind === 'horizontal')!
    expect(() => mutationHandlers.set_constraint_driven(d, {
      type: 'set_constraint_driven', featureId: 'sk1', constraintId: horizontal.id, driven: true,
    })).toThrow(/horizontal cannot be driven/)
  })

  it('a redundant dimension must stay driven: the refusal uses the shared sentence', () => {
    // The probe is the gate an un-drive passes through. A diagonal implied by
    // a fully constrained rectangle must be measured, never made driving.
    const feature = {
      id: 'sk1', kind: 'sketch',
      entities: [
        { id: 'b', kind: 'line' }, { id: 'r', kind: 'line' },
        { id: 't', kind: 'line' }, { id: 'l', kind: 'line' },
      ],
      initial: { b: [0, 0, 10, 0], r: [10, 0, 10, 6], t: [10, 6, 0, 6], l: [0, 6, 0, 0] },
      constraints: [
        { id: 'j1', kind: 'coincident', a: '$bend', b: '$rstart' },
        { id: 'j2', kind: 'coincident', a: '$rend', b: '$tstart' },
        { id: 'j3', kind: 'coincident', a: '$tend', b: '$lstart' },
        { id: 'j4', kind: 'coincident', a: '$lend', b: '$bstart' },
        { id: 'hb', kind: 'horizontal', target: '$b' },
        { id: 'ht', kind: 'horizontal', target: '$t' },
        { id: 'vr', kind: 'vertical', target: '$r' },
        { id: 'vl', kind: 'vertical', target: '$l' },
        { id: 'wb', kind: 'length', target: '$b', value: 10 },
        { id: 'hl', kind: 'length', target: '$l', value: 6 },
        { id: 'diag', kind: 'point_distance', a: '$bstart', b: '$rend', value: Math.hypot(10, 6) },
      ],
    }
    if (!solveBytes) return
    setSketchSolver(solveBytes)
    const d = { kind: 'part', features: [feature] } as unknown as PartDoc
    expect(redundantWithoutConstraint(d, 'sk1', 'diag')).toBe(true)
    expect(overconstrainReason('point_distance')).toMatch(/would overconstrain the sketch/)
  })
})
