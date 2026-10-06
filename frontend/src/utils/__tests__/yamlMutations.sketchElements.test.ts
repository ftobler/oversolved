import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyDeleteElements, applyAddEntityWithConstraint, applyAddImportStep } from '@/utils/yamlMutations'

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
    // Both constraints reference $line1; c_len is explicitly deleted and
    // c_horiz is garbage-collected because it references the deleted entity.
    expect(doc.features![0].constraints).toHaveLength(0)
    expect(doc.features![0].initial!.line1).toBeUndefined()
  })

  it('deletes constraints that reference deleted entities', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].entities).toHaveLength(2)
    // Both constraints reference $line1 and should be garbage-collected
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('deletes constraints referencing deleted entity sub-points', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'Sketch1',
        kind: 'sketch',
        initial: { line1: [0, 0, 10, 0] },
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [
          { id: 'c_coin', kind: 'coincident', a: '$line1start', b: '$line1end' },
        ],
      }],
    }
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('keeps constraints that do not reference deleted entities', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'Sketch1',
        kind: 'sketch',
        initial: { line1: [0, 0, 10, 0], line2: [0, 0, 0, 10] },
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'line2', kind: 'line' },
        ],
        constraints: [
          { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
          { id: 'c_vert', kind: 'vertical', target: '$line2' },
        ],
      }],
    }
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].constraints).toHaveLength(1)
    expect(doc.features![0].constraints![0].id).toBe('c_vert')
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

  it('creates constraint with entity reference when using snapEntityRef', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 5, 5, 5], 'end', undefined, 'coincident', 'entity:Sketch1:line1')
    const newEntity = doc.features![0].entities![1]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}end`)
    expect(newConstraint.b).toBe('$line1')
  })

  it('creates the entity but authors no constraint when neither snap target is provided', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 10, 10], 'start', undefined, 'coincident', undefined)
    expect(doc.features![0].entities).toHaveLength(1)
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('uses source feature ID for cross-sketch snap vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch2:line1:start', 'coincident')
    const newEntity = doc.features![0].entities![0]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}start`)
    // Absolute cross-feature refs are slash-joined (canonical kernel format).
    expect(newConstraint.b).toBe('@Sketch2/line1/start')
  })
})

describe('applyAddImportStep', () => {
  it('adds an import_step feature carrying the registry file id', () => {
    const doc: PartDoc = { features: [] }
    applyAddImportStep(doc, 'f1', 'file-uuid-1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'f1', kind: 'import_step', file_id: 'file-uuid-1' })
    // The inline payload is gone; the document holds a reference only.
    expect('file_data' in doc.features![0]).toBe(false)
  })

  it('sets label when provided', () => {
    const doc: PartDoc = { features: [] }
    applyAddImportStep(doc, 'f1', 'file-uuid-1', 'My Part')
    expect(doc.features![0].label).toBe('My Part')
  })

  it('initialises features array when absent', () => {
    const doc: PartDoc = {}
    applyAddImportStep(doc, 'f1', 'file-uuid-1')
    expect(doc.features).toHaveLength(1)
  })
})

describe('applyAddEntityWithConstraint with @builtin_origin', () => {
  it('creates coincident constraint with @builtin_origin snap target', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'point', [3, 4], 'xy', '@builtin_origin', 'coincident')
    expect(doc.features![0].entities).toHaveLength(1)
    expect(doc.features![0].constraints).toHaveLength(1)
    const c = doc.features![0].constraints![0]
    expect(c.kind).toBe('coincident')
    expect(c.b).toBe('@builtin_origin')
  })
})
