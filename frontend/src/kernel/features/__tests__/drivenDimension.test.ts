// @vitest-environment node
//
// A driven diagonal in an already constrained rectangle is the user's case:
// the driving version is refused as redundant, the reference version solves
// exactly like the rectangle without it and measures the diagonal from the
// solved geometry on every solve.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { redundantWithoutConstraint } from '../constraintProbe'
import { overconstrainReason } from '@/utils/core/constraintRefusals'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo } from '@/kernel/query'

const solveBytes = loadSolver()

const rect = (width: number, extra: unknown[] = []): SketchFeature => ({
  id: 'sk1',
  kind: 'sketch',
  label: 'Rectangle',
  plane: '@builtin_plane_front',
  entities: [
    { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
    { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
  ],
  initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 6], top: [10, 6, 0, 6], left: [0, 6, 0, 0] },
  constraints: [
    // Pin one corner: the four joints, four axis constraints and two sizes
    // leave the whole rectangle free to translate without it.
    { id: 'c_origin', kind: 'coincident', a: { entity: 'bottom', point: 'start' }, b: '@builtin_origin' },
    { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
    { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
    { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
    { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
    { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
    { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
    { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
    { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
    { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: width },
    { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 6 },
    ...extra,
  ],
} as unknown as SketchFeature)

const diagonal = (id: string, driven?: true) => ({
  id, kind: 'point_distance',
  a: { entity: 'bottom', point: 'start' },
  b: { entity: 'right', point: 'end' },
  value: Math.hypot(10, 6),
  ...(driven && { driven }),
})

const solve = (feature: SketchFeature) =>
  solveSketch(feature as unknown as Record<string, unknown>, initGlobalRepo(), {})

describe.skipIf(!solveBytes)('driven reference dimensions', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  it('keeps the rectangle fully constrained with no superfluous row and measures the diagonal', () => {
    setSketchSolver(solveBytes!)
    expect(solve(rect(10)).dof).toBe(0)
    const out = solve(rect(10, [diagonal('c_diag', true)]))
    expect(out.status).toBe('fully_constrained')
    expect(Object.values(out.constraints ?? {}).filter(c => c.superfluous)).toHaveLength(0)
    const rendered = out.constraints?.c_diag
    expect(rendered?.driven).toBe(true)
    expect(rendered?.render).toMatchObject({ kind: 'dim_linear' })
    const value = (rendered?.render as { value: number }).value
    expect(value).toBeCloseTo(Math.hypot(10, 6), 6)
  })

  it('removes the measurement when a driving width changes', () => {
    setSketchSolver(solveBytes!)
    const out = solve(rect(12, [diagonal('c_diag', true)]))
    const value = (out.constraints?.c_diag?.render as { value: number }).value
    expect(value).toBeCloseTo(Math.hypot(12, 6), 6)
  })

  it('the driving twin is redundant: an un-drive probe says so with the shared reason', () => {
    setSketchSolver(solveBytes!)
    const feature = rect(10, [diagonal('c_diag')])
    const out = solve(feature)
    expect(Object.entries(out.constraints ?? {}).filter(([, c]) => c.superfluous).map(([id]) => id))
      .toContain('c_diag')
    const doc = { kind: 'part', features: [feature] } as unknown as PartDoc
    expect(redundantWithoutConstraint(doc, 'sk1', 'c_diag')).toBe(true)
    expect(overconstrainReason('point_distance')).toBe(
      'This would overconstrain the sketch: the point distance is already implied by the existing constraints.',
    )
  })

  it('a driven row is not flagged even when its stored value is stale', () => {
    setSketchSolver(solveBytes!)
    const stale = { ...diagonal('c_diag', true), value: 1 }
    const out = solve(rect(10, [stale]))
    expect(out.constraints?.c_diag?.superfluous).toBeUndefined()
    expect((out.constraints?.c_diag?.render as { value: number }).value).toBeCloseTo(Math.hypot(10, 6), 6)
  })
})
