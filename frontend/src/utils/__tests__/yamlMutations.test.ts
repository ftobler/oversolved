import { describe, it, expect } from 'vitest'
import type { PartDoc, PartConstraint } from '../../types/cad'
import { applyMoveVertex, applyAddConstraint, applyDeleteElements, applySetConstraintPos } from '../yamlMutations'

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

// ── Step 6: face: selection ID handling ───────────────────────────────────────

import { parseTarget, applyAddConstraint } from '../yamlMutations'

const docWithSketch = (id: string): PartDoc => ({
  version: 1, kind: 'part',
  features: [{ id, kind: 'sketch', entities: [{ id: 'lineA', kind: 'line' }], initial: { lineA: [0,0,10,0] }, constraints: [] }],
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
