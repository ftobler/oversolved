import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFeatureSolver } from './solverRegistry'
import type { FeatureResult } from './builder'
import type { OccModule } from './occ/occTypes'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { Repository } from './query'

// The createFeatureSolver adapter has two pre-dispatch short-circuits that the
// existing suite does not drive THROUGH the adapter: the `variable` kind (no
// geometry, evaluated against the variable context) and the expression-
// resolution failure (a bad math expression is rejected before the leaf solver
// runs). solveVariable and resolveFeatureExpressions are unit-tested directly
// elsewhere; these pin their routing inside the adapter.

describe('createFeatureSolver pre-dispatch short-circuits', () => {
  const fakeOc = {} as OccModule
  let scope: DisposeScope
  let table: HandleTable

  beforeEach(() => {
    scope = new DisposeScope()
    table = new HandleTable({ finalizerGuard: false })
  })

  afterEach(() => {
    scope.dispose()
  })

  it('evaluates a variable feature without touching the OCC path', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const result = solver(
      { id: 'width', kind: 'variable', label: 'width', variable: { expression: '10+5' } },
      new Repository(),
      {},
      {},
    ) as FeatureResult & { value?: number }
    expect(result.status).toBe('ok')
    expect(result.value).toBe(15)
  })

  it('resolves a variable expression against the injected context', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const result = solver(
      { id: 'height', kind: 'variable', label: 'height', variable: { expression: 'width*2' } },
      new Repository(),
      {},
      {},
      { width: 7 },
    ) as FeatureResult & { value?: number }
    expect(result.status).toBe('ok')
    expect(result.value).toBe(14)
  })

  it('returns an exception when a leaf feature carries an invalid expression', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const result = solver(
      { id: 'e1', kind: 'extrude', extrude: { distance: '2+/' } },
      new Repository(),
      {},
      {},
    ) as FeatureResult
    // The bad expression is rejected before the (OCC-backed) extrude solver runs,
    // so this never throws -- it surfaces as a clean exception result.
    expect(result.status).toBe('exception')
    expect(String(result.exception)).toContain('2+/')
  })
})
