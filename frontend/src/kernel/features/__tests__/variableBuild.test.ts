// Builder-level integration: the build loop accumulates named-variable values in
// feature order and threads them into each feature's solve so downstream
// expression fields (and later variables) resolve named references. OCC-free:
// uses a mock trySolveFeature that mirrors createFeatureSolver's variable +
// expression behavior.

import { describe, it, expect } from 'vitest'
import { build, type BuildDeps, type FeatureResult } from '../../builder'
import { Repository } from '../../query'
import { solveVariable, variableScopeAt } from '../variable'
import { resolveFeatureExpressions } from '../../solverRegistry'
import type { PartFeature } from '@/types/cad'

function deps(): BuildDeps {
  return {
    trySolveFeature: (feature, _repo, _partStore, _featuresById, variableContext, laterVariables): FeatureResult => {
      const ctx = variableContext ?? {}
      if (feature.kind === 'variable') return solveVariable(feature, ctx, laterVariables ?? {})
      if (feature.kind === 'extrude') {
        const resolved = resolveFeatureExpressions(feature, ctx, laterVariables ?? {})
        if ('exception' in resolved) return { status: 'exception', exception: resolved.exception }
        return { status: 'ok', resolvedDistance: (resolved.feature.extrude as { distance: number }).distance }
      }
      return { status: 'ok' }
    },
    postRegister: () => {},
    initGlobalRepo: () => new Repository(),
    tessellateParts: () => ({}),
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

  it('names a forward reference and builds once the variable is moved up', () => {
    const forward = {
      features: [
        { id: 'ex1', kind: 'extrude', extrude: { distance: 'width+50' } },
        { id: 'width', kind: 'variable', label: 'width', variable: { expression: '100' } },
      ],
    }
    const failed = build(forward, { prevState: null }, deps()).result as Record<string, FeatureResult>
    expect(failed.ex1).toMatchObject({
      status: 'exception',
      exception:
        "distance: variable 'width' is defined after this feature (at index 1); "
        + 'move it up with reorder_features',
    })

    const reordered = {
      features: [forward.features[1], forward.features[0]],
    }
    const built = build(reordered, { prevState: null }, deps()).result as Record<string, FeatureResult>
    expect(built.ex1).toMatchObject({ status: 'ok', resolvedDistance: 150 })
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

  it('hands each feature the same scope variableScopeAt reports for it', () => {
    // The editor reads variableScopeAt, the solve reads the builder's live
    // context. They must agree feature by feature, including a suppressed
    // variable and one that fails.
    const features = [
      { id: 'w', kind: 'variable', label: 'w', variable: { expression: 10 } },
      { id: 'sk', kind: 'sketch', entities: [], initial: {} },
      { id: 'bad', kind: 'variable', label: 'bad', variable: { expression: '2+/' } },
      { id: 'h', kind: 'variable', label: 'h', variable: { expression: 'w*2' } },
      { id: 'skip', kind: 'variable', label: 'skip', variable: { expression: 7 }, suppressed: true },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '', distance: 'w+h' } },
    ]
    const seen: Record<string, Record<string, number>> = {}
    const capture: BuildDeps = {
      ...deps(),
      trySolveFeature: (feature, _repo, _partStore, _featuresById, variableContext, laterVariables): FeatureResult => {
        const ctx = variableContext ?? {}
        seen[String(feature.id)] = { ...ctx }
        if (feature.kind === 'variable') return solveVariable(feature, ctx, laterVariables ?? {})
        if (feature.kind === 'extrude') return { status: 'ok' }
        return { status: 'ok' }
      },
    }
    build({ features }, { prevState: null }, capture)
    for (let i = 0; i < features.length; i++) {
      // The builder never calls a solver for a suppressed row, so there is no
      // context to compare against.
      if (features[i].suppressed) continue
      expect(seen[features[i].id]).toEqual(variableScopeAt(features as unknown as PartFeature[], i))
    }
  })
})
