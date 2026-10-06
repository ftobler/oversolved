// Builder-level integration: the build loop accumulates named-variable values in
// feature order and threads them into each feature's solve so downstream
// expression fields (and later variables) resolve named references. OCC-free:
// uses a mock trySolveFeature that mirrors createFeatureSolver's variable +
// expression behavior.

import { describe, it, expect } from 'vitest'
import { build, type BuildDeps, type FeatureResult } from '../../builder'
import { Repository } from '../../query'
import { solveVariable } from '../variable'
import { evalExpr } from '../../evalExpr'

function deps(): BuildDeps {
  return {
    trySolveFeature: (feature, _repo, _bodyStore, _featuresById, variableContext): FeatureResult => {
      const ctx = variableContext ?? {}
      if (feature.kind === 'variable') return solveVariable(feature, ctx)
      if (feature.kind === 'extrude') {
        const distance = (feature.extrude as { distance: string }).distance
        return { status: 'ok', resolvedDistance: evalExpr(distance, ctx) }
      }
      return { status: 'ok' }
    },
    postRegister: () => {},
    initGlobalRepo: () => new Repository(),
    tessellateBodies: () => ({}),
  }
}

describe('variable build integration', () => {
  it('resolves an extrude distance from a preceding variable', () => {
    const spec = {
      features: [
        { id: 'width', kind: 'variable', label: 'width', variable: { expression: '100' } },
        { id: 'ex1', kind: 'extrude', extrude: { distance: 'width+50' } },
      ],
    }
    const res = build(spec, { prevState: null }, deps()).result as Record<string, FeatureResult>
    expect(res.width).toMatchObject({ value: 100 })
    expect(res.ex1).toMatchObject({ resolvedDistance: 150 })
  })

  it('chains variable references in order', () => {
    const spec = {
      features: [
        { id: 'a', kind: 'variable', label: 'a', variable: { expression: '10' } },
        { id: 'b', kind: 'variable', label: 'b', variable: { expression: 'a*5' } },
        { id: 'ex1', kind: 'extrude', extrude: { distance: 'b+2' } },
      ],
    }
    const res = build(spec, { prevState: null }, deps()).result as Record<string, FeatureResult>
    expect(res.a).toMatchObject({ value: 10 })
    expect(res.b).toMatchObject({ value: 50 })
    expect(res.ex1).toMatchObject({ resolvedDistance: 52 })
  })

  it('errors a forward reference (variable defined later)', () => {
    const spec = {
      features: [
        { id: 'a', kind: 'variable', label: 'a', variable: { expression: 'b+1' } },
        { id: 'b', kind: 'variable', label: 'b', variable: { expression: '10' } },
      ],
    }
    const res = build(spec, { prevState: null }, deps()).result as Record<string, FeatureResult>
    expect(res.a).toMatchObject({ status: 'exception' })
    expect(res.b).toMatchObject({ value: 10 })
  })
})
