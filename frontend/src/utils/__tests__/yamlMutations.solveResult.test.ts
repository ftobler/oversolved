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
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
        ],
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

  it('adopts the resolved kind of a projected entity (ellipse -> spline)', () => {
    // A partial elliptical edge lowers to a spline (8 params); the doc entity
    // was declared 'ellipse' at pick time and must adopt the resolved kind so
    // its kind and stored params stay consistent.
    const doc = makeDoc()
    applyGeometryToFeature(
      doc, 'sk1',
      { proj1: [0, 0, 1, 1, 2, 1, 3, 0] },
      new Set(),
      { proj1: 'spline' },
    )
    const feat = doc.features!.find(f => f.id === 'sk1')!
    const proj = feat.entities!.find(e => e.id === 'proj1')!
    expect(proj.kind).toBe('spline')
    expect(feat.initial!.proj1).toHaveLength(8)
  })

  it('leaves kinds untouched when no resolved kinds are given', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', { proj1: [0, 0, 4, 2, 0] }, new Set())
    const proj = doc.features!.find(f => f.id === 'sk1')!.entities!.find(e => e.id === 'proj1')!
    expect(proj.kind).toBe('ellipse')
  })

  it('returns false when projectionErrors is absent', () => {
    const doc = makeDoc()
    const changed = applyGeometryToFeature(doc, 'sk1', {}, new Set())
    expect(changed).toBe(false)
  })

  it('returns false when projectionErrors is empty', () => {
    const doc = makeDoc()
    const changed = applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, [])
    expect(changed).toBe(false)
  })

  it('removes a failed projected entity from the feature', () => {
    const doc = makeDoc()
    const changed = applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, ['proj1'])
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(changed).toBe(true)
    // proj1 had a source field -> removed; line1 (no source) stays
    expect(feat.entities!.map(e => e.id)).toEqual(['line1'])
  })

  it('does not remove entities without a source field even if listed in projectionErrors', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, ['line1'])
    const feat = doc.features!.find(f => f.id === 'sk1')!
    // line1 has no source -> not treated as a projected entity -> kept
    expect(feat.entities!.map(e => e.id)).toContain('line1')
  })

  it('drops constraints that reference a removed projected entity', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
        ],
        constraints: [
          { id: 'c_keep', kind: 'horizontal', target: '$line1' },
          { id: 'c_drop_a', kind: 'coincident', a: '$line1end', b: '$proj1start' },
          { id: 'c_drop_b', kind: 'length', target: '$proj1' },
        ],
      }],
    }
    applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, ['proj1'])
    const feat = doc.features!.find(f => f.id === 'sk1')!
    const ids = feat.constraints!.map(c => c.id)
    expect(ids).toContain('c_keep')
    expect(ids).not.toContain('c_drop_a')
    expect(ids).not.toContain('c_drop_b')
  })

  it('drops constraints that reference a removed entity via refs array', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
          { id: 'line2', kind: 'line' },
          { id: 'line3', kind: 'line' },
        ],
        constraints: [
          { id: 'c_keep', kind: 'ngon', refs: ['$line1', '$line2', '$line3'] },
          { id: 'c_drop', kind: 'ngon', refs: ['$line1', '$proj1', '$line3'] },
        ],
      }],
    }
    applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, ['proj1'])
    const feat = doc.features!.find(f => f.id === 'sk1')!
    const ids = feat.constraints!.map(c => c.id)
    expect(ids).toContain('c_keep')
    expect(ids).not.toContain('c_drop')
  })

  it('returns false when none of the errored entities have a source field', () => {
    const doc = makeDoc()
    const changed = applyGeometryToFeature(doc, 'sk1', {}, new Set(), undefined, ['line1'])
    expect(changed).toBe(false)
  })
})
