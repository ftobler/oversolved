// @vitest-environment node
//
// Focused tests for projected-entity lowering inside solveSketch: a `$sibling`
// source reuses the already-solved sibling params and pins the entity, and a
// source query that fails to resolve is dropped (reported, not fatal) so the
// rest of the sketch still builds. Skips when the Rust solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { Repository } from '../query'
import type { PartFeature } from '@/types/cad'

const solveBytes = loadSolver()

describe.skipIf(!solveBytes)('solveSketch projected-entity lowering', () => {
  beforeAll(() => setSketchSolver(solveBytes))
  afterAll(() => resetSketchSolver())

  it('adopts a $sibling source params and pins the projected entity', () => {
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'A', kind: 'line' },
        { id: 'B', kind: 'line', source: '$A' },
      ],
      initial: { A: [0, 0, 10, 0], B: [9, 9, 9, 9] },
      constraints: [],
    } as unknown as PartFeature
    const result = solveSketch(feature as unknown as Record<string, unknown>, new Repository(), {})
    // The projection seeds B from A's params, overriding the stale initial.
    expect(result.geometry?.B).toEqual([0, 0, 10, 0])
  })

  it('drops an unresolvable source and reports it without failing the sketch', () => {
    const repo = new Repository()
    repo.query = ((): never => {
      throw new Error('registry offline')
    }) as Repository['query']
    const feature = {
      id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'L1', kind: 'line' },
        { id: 'P1', kind: 'point', source: '@boom' },
      ],
      initial: { L1: [0, 0, 4, 0] },
      constraints: [],
    } as unknown as PartFeature
    const result = solveSketch(feature as unknown as Record<string, unknown>, repo, {})
    expect(result.projection_errors).toEqual(['P1'])
    expect(result.geometry?.L1).toEqual([0, 0, 4, 0])
  })

  it('projects a resolved line source into pinned entity params', () => {
    const repo = new Repository()
    repo.query = (() => ({ type: 'edge', kind: 'line', start: [0, 0, 0], end: [5, 0, 0] })) as Repository['query']
    const feature = {
      id: 'sk3', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'L1', kind: 'line', source: '@edge1' }],
      initial: {},
      constraints: [],
    } as unknown as PartFeature
    const result = solveSketch(feature as unknown as Record<string, unknown>, repo, {})
    expect(result.projection_errors).toBeUndefined()
    expect(result.geometry?.L1).toEqual([0, 0, 5, 0])
  })

  it('surfaces a tilted-circle projection as an ellipse entity kind', () => {
    // A circle whose plane is not parallel to the sketch plane must lower to an
    // ellipse; the doc entity adopts the resolved kind so its param count fits.
    const repo = new Repository()
    repo.query = (() => ({
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 2, axis: [0, 1, 0], x_axis: [1, 0, 0],
    })) as Repository['query']
    const feature = {
      id: 'sk4', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'C1', kind: 'circle', source: '@edge2' }],
      initial: {},
      constraints: [],
    } as unknown as PartFeature
    const result = solveSketch(feature as unknown as Record<string, unknown>, repo, {})
    expect(result.resolved_kinds).toEqual({ C1: 'ellipse' })
    expect(result.geometry?.C1).toHaveLength(5)
  })
})
