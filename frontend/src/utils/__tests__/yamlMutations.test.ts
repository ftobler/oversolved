import { describe, it, expect } from 'vitest'
import type { PartDoc, PartConstraint } from '../../types/cad'
import { applyMoveVertex, applyAddConstraint, applyDeleteElements, applySetConstraintPos, applyAddPlane, applySetPlaneDefinitionField, applyAddEntityWithConstraint } from '../yamlMutations'

const makeSampleDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    {
      id: 'Sketch1',
      kind: 'sketch',
      initial: {
        line1: [0, 0, 10, 0],
        circ1: [5, 5, 3],
        pt1: [1, 2],
      },
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'circ1', kind: 'circle' },
        { id: 'pt1', kind: 'point' },
      ],
      constraints: [
        { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
        { id: 'c_len', kind: 'length', target: '$line1', value: 10 },
      ],
    },
  ],
})

describe('applyMoveVertex', () => {
  it('moves line start', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [2, 3])
    expect(doc.features![0].initial!.line1).toEqual([2, 3, 10, 0])
  })

  it('moves line end', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 15, 5])
  })

  it('moves circle center', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'circ1', 'center', [7, 8])
    expect(doc.features![0].initial!.circ1).toEqual([7, 8, 3])
  })

  it('moves point xy', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'pt1', 'xy', [9.5, 10.5])
    expect(doc.features![0].initial!.pt1).toEqual([9.5, 10.5])
  })

  it('no-ops for unknown entity', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'nonexistent', 'start', [0, 0])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 10, 0])
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [1.23456789, 9.87654321])
    expect(doc.features![0].initial!.line1[0]).toBe(1.234568)
    expect(doc.features![0].initial!.line1[1]).toBe(9.876543)
  })
})

describe('applyAddConstraint', () => {
  it('adds a single-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_vertical'))
    expect(added).toBeDefined()
    expect(added!.kind).toBe('vertical')
    expect(added!.target).toEqual('$line1')
  })

  it('adds a two-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'normal', ['entity:Sketch1:line1', 'entity:Sketch1:circ1'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_normal'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1')
    expect(added!.b).toEqual('$circ1')
  })

  it('adds constraint with vertex point reference', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_coincident'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('generates unique constraint ids', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:circ1'])
    const ids = doc.features![0].constraints!.map((c: PartConstraint) => c.id)
    const vertIds = ids.filter((id: string) => id.startsWith('c_vertical'))
    expect(new Set(vertIds).size).toBe(vertIds.length)
  })

  it('adds constraint with value', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 42)
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_length'))
    expect(added!.value).toBe(42)
  })
})

describe('applySetConstraintPos', () => {
  it('sets pos on an existing constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [3.5, -2.0])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos).toEqual([3.5, -2.0])
  })

  it('rounds pos to 6 decimal places', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [1.23456789, -9.87654321])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos![0]).toBe(1.234568)
    expect(c!.pos![1]).toBe(-9.876543)
  })

  it('no-ops for unknown constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_nonexistent', [1, 2])
    // No pos set on any constraint
    for (const c of doc.features![0].constraints!) {
      expect(c.pos).toBeUndefined()
    }
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'NoSuchFeature', 'c_len', [1, 2])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos).toBeUndefined()
  })
})

describe('applyDeleteElements', () => {
  it('deletes an entity from entities list and initial', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:circ1'])
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].entities!.map(e => e.id)).not.toContain('circ1')
    expect(doc.features![0].initial!.circ1).toBeUndefined()
    expect(doc.features![0].initial!.line1).toBeDefined()
  })

  it('deletes a constraint', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['constraint:Sketch1:c_horiz'])
    expect(doc.features![0].constraints).toHaveLength(1)
    expect(doc.features![0].constraints![0].id).toBe('c_len')
  })

  it('deletes multiple elements at once', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:line1', 'constraint:Sketch1:c_len'])
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].constraints).toHaveLength(1)
    expect(doc.features![0].initial!.line1).toBeUndefined()
  })
})

// ── Step 6: face: selection ID handling ────

import { parseTarget, applySetFeatureVisibility } from '../yamlMutations'
import { healDoc, BUILTIN_FEATURE_DEFAULTS } from '../../hooks/usePartDoc'

const docWithSketch = (id: string): PartDoc => ({
  version: 1, kind: 'part',
  features: [{ id, kind: 'sketch', entities: [{ id: 'lineA', kind: 'line' }], initial: { lineA: [0,0,10,0] }, constraints: [] }],
})

// 6c: parseTarget for @featureId feature-plane references
// A bare @<featureId> (no element suffix) is a feature-plane reference.
// parseTarget must pass it through unchanged so the solver can resolve
// it to the feature's defining plane.
describe('parseTarget for feature-plane references', () => {
  it('passes through @featureId unchanged (sketch feature-plane ref)', () => {
    expect(parseTarget('@sketch1', 'sketch2')).toBe('@sketch1')
  })

  it('passes through @featureId unchanged even from same feature context', () => {
    expect(parseTarget('@sketch1', 'sketch1')).toBe('@sketch1')
  })

  it('passes through builtin plane references unchanged', () => {
    expect(parseTarget('@builtin_plane_front', 'sketch1')).toBe('@builtin_plane_front')
    expect(parseTarget('@builtin_plane_top', 'sketch1')).toBe('@builtin_plane_top')
    expect(parseTarget('@builtin_plane_right', 'sketch1')).toBe('@builtin_plane_right')
  })

  it('passes through @extrude feature-plane ref unchanged', () => {
    // @extrude1 will resolve to extrude1's origin/top plane (TBD by backend).
    // The frontend must pass it through without modification.
    expect(parseTarget('@extrude1', 'sketch2')).toBe('@extrude1')
  })
})

// 6a: parseTarget for face: IDs
describe('parseTarget for face IDs', () => {
  it('returns raw query for face from different feature', () => {
    expect(parseTarget('face:sketch0:?3;@sketch0abc', 'sketch1')).toBe('?3;@sketch0abc')
  })

  it('returns raw query for face from same feature', () => {
    expect(parseTarget('face:sketch1:?3;@sketch1abc', 'sketch1')).toBe('?3;@sketch1abc')
  })

  it('preserves colon in type restriction suffix', () => {
    expect(parseTarget('face:sketch0:?9,9;@sketch0la@sketch0lb:face', 'sketch1')).toBe('?9,9;@sketch0la@sketch0lb:face')
  })
})

// 6b: applyAddConstraint stores face query verbatim
describe('applyAddConstraint with face target', () => {
  it('stores face ancestry query verbatim as constraint field', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?3;@sketch0abc'])
    const c = doc.features![0].constraints![0]
    expect(c.b).toBe('?3;@sketch0abc')
  })

  it('stores face query with type restriction verbatim', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?9,9;@sketch0la@sketch0lb:face'])
    const c = doc.features![0].constraints![0]
    expect(c.b).toBe('?9,9;@sketch0la@sketch0lb:face')
  })
})

// ── Feature visibility (applySetFeatureVisibility) ────

const docWithFeatures = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Front',  kind: 'plane' },
    { id: 'sketch1', kind: 'sketch' },
  ],
})

describe('applySetFeatureVisibility', () => {
  it('sets visible:false when hiding', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'sketch1')!.visible).toBe(false)
  })

  it('removes the visible property when showing (keeps YAML clean)', () => {
    const doc = docWithFeatures()
    doc.features!.find(f => f.id === 'sketch1')!.visible = false
    applySetFeatureVisibility(doc, 'sketch1', true)
    expect('visible' in doc.features!.find(f => f.id === 'sketch1')!).toBe(false)
  })

  it('works on built-in features (origin)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Origin', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBe(false)
  })

  it('works on built-in features (plane)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Front', false)
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBe(false)
  })

  it('no-ops for unknown feature id', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'nonexistent', false)
    expect(doc.features!.every(f => f.visible === undefined)).toBe(true)
  })

  it('does not affect other features when hiding one', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBeUndefined()
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBeUndefined()
  })
})

// ── healDoc — built-in injection and visibility preservation ────

describe('healDoc built-in injection', () => {
  it('injects all four built-ins into an empty doc', () => {
    const doc = healDoc({})
    const ids = doc.features!.map(f => f.id)
    expect(ids).toContain('Origin')
    expect(ids).toContain('Top')
    expect(ids).toContain('Front')
    expect(ids).toContain('Right')
  })

  it('places built-ins before user features', () => {
    const doc = healDoc({ features: [{ id: 'sketch1', kind: 'sketch' }] })
    const ids = doc.features!.map(f => f.id)
    const builtinIdx = Math.max(...BUILTIN_FEATURE_DEFAULTS.map(b => ids.indexOf(b.id)))
    const sketchIdx = ids.indexOf('sketch1')
    expect(builtinIdx).toBeLessThan(sketchIdx)
  })

  it('does not duplicate built-ins already in the doc', () => {
    const doc = healDoc({
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top',    kind: 'plane' },
        { id: 'Front',  kind: 'plane' },
        { id: 'Right',  kind: 'plane' },
        { id: 'sketch1', kind: 'sketch' },
      ],
    })
    const originCount = doc.features!.filter(f => f.id === 'Origin').length
    expect(originCount).toBe(1)
    expect(doc.features!).toHaveLength(5)
  })

  it('preserves visible:false on a built-in already in the doc', () => {
    const doc = healDoc({
      features: [
        { id: 'Origin', kind: 'origin', visible: false },
        { id: 'Top',    kind: 'plane' },
        { id: 'Front',  kind: 'plane' },
        { id: 'Right',  kind: 'plane' },
      ],
    })
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBe(false)
  })

  it('injects only missing built-ins when some are present', () => {
    const doc = healDoc({
      features: [{ id: 'Front', kind: 'plane' }],
    })
    const ids = doc.features!.map(f => f.id)
    expect(ids).toContain('Origin')
    expect(ids).toContain('Top')
    expect(ids).toContain('Front')
    expect(ids).toContain('Right')
    expect(doc.features!.filter(f => f.id === 'Front')).toHaveLength(1)
  })

  it('preserves user feature order after built-ins', () => {
    const doc = healDoc({
      features: [
        { id: 'sketch2', kind: 'sketch' },
        { id: 'sketch1', kind: 'sketch' },
      ],
    })
    const ids = doc.features!.map(f => f.id)
    const sketch2Idx = ids.indexOf('sketch2')
    const sketch1Idx = ids.indexOf('sketch1')
    expect(sketch2Idx).toBeLessThan(sketch1Idx)
  })
})

describe('applyAddPlane', () => {
  it('adds a plane feature with default offset mode', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toEqual({ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } })
  })

  it('creates features array if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
  })

  it('appends to existing features', () => {
    const doc = makeSampleDoc()
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(2)
    expect(doc.features![1].id).toBe('plane1')
  })
})

describe('applySetPlaneDefinitionField', () => {
  it('sets plane field on a plane feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'plane', '@builtin_plane_top')
    expect(doc.features![0].definition!.plane).toBe('@builtin_plane_top')
  })

  it('sets offset field', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'offset', 25)
    expect(doc.features![0].definition!.offset).toBe(25)
  })

  it('creates definition if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane' }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'mode', 'three_point')
    expect(doc.features![0].definition).toBeDefined()
    expect((doc.features![0].definition as Record<string, unknown>).mode).toBe('three_point')
  })

  it('is no-op for unknown featureId', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    expect(() => applySetPlaneDefinitionField(doc, 'nonexistent', 'plane', '@builtin_plane_top')).not.toThrow()
  })
})

describe('applyAddEntityWithConstraint', () => {
  it('adds entity and creates coincident constraint with existing vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [{ id: 'c1', kind: 'horizontal', target: '$line1' }],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [5, 5, 15, 5], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].entities![1].kind).toBe('line')
    expect(doc.features![0].initial![doc.features![0].entities![1].id]).toEqual([5, 5, 15, 5])
    expect(doc.features![0].constraints).toHaveLength(2)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')
    expect(newConstraint).toBeDefined()
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'point', [1.23456789, 9.87654321], 'xy', 'vertex:Sketch1:line1:end', 'coincident')
    const newEntity = doc.features![0].entities![1]
    expect(doc.features![0].initial![newEntity.id]![0]).toBe(1.234568)
    expect(doc.features![0].initial![newEntity.id]![1]).toBe(9.876543)
  })

  it('is no-op for unknown feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Nonexistent', 'line', [0, 0, 10, 10], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(0)
  })

  it('creates concentric constraint for circle center snapping', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'circ1', kind: 'circle' }],
      initial: { circ1: [0, 0, 5] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'circle', [0, 0, 3], 'center', 'vertex:Sketch1:circ1:center', 'concentric')
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].constraints).toHaveLength(1)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'concentric')
    expect(newConstraint).toBeDefined()
    expect(newConstraint!.a).toBeDefined()
    expect(newConstraint!.b).toBeDefined()
  })

  it('constraint references new entity vertex and existing vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch1:line1:start', 'coincident')
    const newEntity = doc.features![0].entities![1]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}start`)
    expect(newConstraint.b).toBe('$line1start')
  })

  it('handles arc end vertex snapping', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'arc1', kind: 'arc' }],
      initial: { arc1: [5, 5, 3, 0, 90] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'arc', [5, 5, 3, 0, 90], 'end', 'vertex:Sketch1:arc1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(2)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')
    expect(newConstraint).toBeDefined()
  })

  it('generates unique entity ids', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 10, 10], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    const entities = doc.features![0].entities
    expect(entities).toHaveLength(2)
    expect(entities![0].id).not.toBe(entities![1].id)
  })
})
