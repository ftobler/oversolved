import { describe, it, expect } from 'vitest'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [
          { id: 'c1', kind: 'horizontal' },
          { id: 'c2', kind: 'vertical' },
        ],
      },
      {
        id: 'ex1',
        kind: 'extrude',
      },
    ],
  }
}

describe('applyGeometryToFeature', () => {
  it('writes geometry to feature.initial', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', { line1_start: [0, 0], line1_end: [1, 1] }, new Set())
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.initial).toEqual({ line1_start: [0, 0], line1_end: [1, 1] })
  })

  it('removes superfluous constraints', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {}, new Set(['c1']))
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.constraints).toHaveLength(1)
    expect(feat.constraints![0].id).toBe('c2')
  })

  it('leaves constraints unchanged when superfluous set is empty', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {}, new Set())
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.constraints).toHaveLength(2)
  })

  it('leaves unrelated features untouched', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', { x: [1] }, new Set(['c1']))
    const extrude = doc.features!.find(f => f.id === 'ex1')!
    expect(extrude.initial).toBeUndefined()
  })

  it('no-ops gracefully when featureId is not found', () => {
    const doc = makeDoc()
    expect(() =>
      applyGeometryToFeature(doc, 'missing', {}, new Set())
    ).not.toThrow()
  })
})
