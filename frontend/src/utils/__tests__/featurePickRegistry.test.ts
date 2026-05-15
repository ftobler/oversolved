import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  PRIMARY_PICK_FIELD,
  isCompatibleWithField,
  applyCompatibleSelection,
} from '@/utils/featurePickRegistry'

describe('PRIMARY_PICK_FIELD', () => {
  it('maps every add_* mutation to a primary pick field', () => {
    const expectedAddMutations = [
      'add_extrude',
      'add_revolve',
      'add_fillet',
      'add_chamfer',
      'add_boolean',
      'add_hole',
      'add_delete_body',
      'add_array',
      'add_mirror',
      'add_transform',
    ]
    for (const key of expectedAddMutations) {
      expect(PRIMARY_PICK_FIELD[key]).toBeDefined()
    }
  })

  it('does not include non-add mutations', () => {
    expect(PRIMARY_PICK_FIELD.add_sketch).toBeUndefined()
    expect(PRIMARY_PICK_FIELD.add_plane).toBeUndefined()
    expect(PRIMARY_PICK_FIELD.add_import_step).toBeUndefined()
  })
})

describe('isCompatibleWithField', () => {
  it('sketch field accepts entity: prefixed IDs', () => {
    expect(isCompatibleWithField('entity:sk1:circle1', 'sketch', 'extrude')).toBe(true)
    expect(isCompatibleWithField('entity:sk2:line1', 'sketch', 'revolve')).toBe(true)
  })

  it('sketch field accepts face: prefixed IDs', () => {
    expect(isCompatibleWithField('face:ex1:?some;query', 'sketch', 'extrude')).toBe(true)
  })

  it('sketch field accepts @ prefixed IDs (not body or builtin)', () => {
    expect(isCompatibleWithField('@sk1', 'sketch', 'extrude')).toBe(true)
    expect(isCompatibleWithField('@body_1', 'sketch', 'extrude')).toBe(false)
    expect(isCompatibleWithField('@builtin_plane_front', 'sketch', 'extrude')).toBe(false)
  })

  it('edges field accepts face:, ?, @/, and :edge IDs', () => {
    expect(isCompatibleWithField('face:ex1:?query', 'edges', 'fillet')).toBe(true)
    expect(isCompatibleWithField('?body1:edge2', 'edges', 'fillet')).toBe(true)
    expect(isCompatibleWithField('@body_1/edge/2', 'edges', 'fillet')).toBe(true)
    expect(isCompatibleWithField('edge:ex1:feat1:0', 'edges', 'chamfer')).toBe(true)
  })

  it('edges field rejects entity: IDs', () => {
    expect(isCompatibleWithField('entity:sk1:circle1', 'edges', 'fillet')).toBe(false)
  })

  it('body / boolean_target / boolean_tool accept body:, @body_, ?, @ IDs', () => {
    expect(isCompatibleWithField('@body_1', 'body', 'delete_body')).toBe(true)
    expect(isCompatibleWithField('@body_2', 'boolean_target', 'boolean')).toBe(true)
    expect(isCompatibleWithField('@body_3', 'boolean_tool', 'boolean')).toBe(true)
    expect(isCompatibleWithField('body:feat1', 'body', 'transform')).toBe(true)
    expect(isCompatibleWithField('?ancestry;query', 'body', 'mirror')).toBe(true)
    expect(isCompatibleWithField('@someRef', 'body', 'array')).toBe(true)
  })

  it('body field rejects @builtin_ IDs', () => {
    expect(isCompatibleWithField('@builtin_plane_front', 'body', 'transform')).toBe(false)
  })

  it('unknown field returns false', () => {
    expect(isCompatibleWithField('entity:sk1:circle1', 'unknown_field')).toBe(false)
  })
})

describe('applyCompatibleSelection', () => {
  function makeDocWithFeature(kind: string, id: string, extra?: Record<string, unknown>): PartDoc {
    const feature: Record<string, unknown> = { id, kind, ...extra }
    return { features: [feature as PartDoc['features'] extends (infer T)[] ? T : never] }
  }

  it('applies sketch profile to extrude', () => {
    const doc = makeDocWithFeature('extrude', 'ex1', { extrude: { sketch: [], distance: 10 } })
    applyCompatibleSelection(doc, 'ex1', 'sketch', 'extrude', 'entity:sk1:circle1')
    expect((doc.features![0] as { extrude: { sketch: string[] } }).extrude?.sketch).toContain('entity:sk1:circle1')
  })

  it('applies sketch profile to revolve', () => {
    const doc = makeDocWithFeature('revolve', 'r1', { revolve: { sketch: [], angle: 360 } })
    applyCompatibleSelection(doc, 'r1', 'sketch', 'revolve', 'entity:sk1:circle1')
    expect((doc.features![0] as { revolve: { sketch: string[] } }).revolve?.sketch).toContain('entity:sk1:circle1')
  })

  it('applies sketch to hole', () => {
    const doc = makeDocWithFeature('hole', 'h1', { hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20 } })
    applyCompatibleSelection(doc, 'h1', 'sketch', 'hole', 'entity:sk1:point1')
    expect((doc.features![0] as { hole: { sketch: string } }).hole?.sketch).toBe('entity:sk1:point1')
  })

  it('applies edge to fillet', () => {
    const doc = makeDocWithFeature('fillet', 'f1', { fillet: { edges: [], radius: 5 } })
    applyCompatibleSelection(doc, 'f1', 'edges', 'fillet', 'face:ex1:?some;query')
    expect((doc.features![0] as { fillet: { edges: string[] } }).fillet?.edges).toContain('face:ex1:?some;query')
  })

  it('applies edge to chamfer', () => {
    const doc = makeDocWithFeature('chamfer', 'c1', { chamfer: { edges: [], distance: 2 } })
    applyCompatibleSelection(doc, 'c1', 'edges', 'chamfer', '?body1:edge3')
    expect((doc.features![0] as { chamfer: { edges: string[] } }).chamfer?.edges).toContain('?body1:edge3')
  })

  it('applies body ref to boolean target', () => {
    const doc = makeDocWithFeature('boolean', 'b1', { boolean: { operation: 'union', target: '', tools: [] } })
    applyCompatibleSelection(doc, 'b1', 'boolean_target', 'boolean', '@body_1')
    expect((doc.features![0] as { boolean: { target: string } }).boolean?.target).toBe('@body_1')
  })

  it('applies body ref to boolean tool (multi-pick)', () => {
    const doc = makeDocWithFeature('boolean', 'b1', { boolean: { operation: 'union', target: '@body_1', tools: [] } })
    applyCompatibleSelection(doc, 'b1', 'boolean_tool', 'boolean', '@body_2')
    expect((doc.features![0] as { boolean: { tools: string[] } }).boolean?.tools).toContain('@body_2')
  })

  it('applies body ref to delete_body', () => {
    const doc = makeDocWithFeature('delete_body', 'd1', { delete_body: { body: '' } })
    applyCompatibleSelection(doc, 'd1', 'body', 'delete_body', '@body_1')
    expect((doc.features![0] as { delete_body: { body: string } }).delete_body?.body).toBe('@body_1')
  })

  it('applies body ref to transform', () => {
    const doc = makeDocWithFeature('transform', 't1', { transform: { body: '', operation: 'new', translation: [0, 0, 0] } })
    applyCompatibleSelection(doc, 't1', 'body', 'transform', '@body_1')
    expect((doc.features![0] as { transform: { body: string } }).transform?.body).toBe('@body_1')
  })

  it('applies body ref to mirror', () => {
    const doc = makeDocWithFeature('mirror', 'm1', { mirror: { body: '', plane: '' } })
    applyCompatibleSelection(doc, 'm1', 'body', 'mirror', '@body_1')
    expect((doc.features![0] as { mirror: { body: string } }).mirror?.body).toBe('@body_1')
  })

  it('applies body ref to array (source_body)', () => {
    const doc = makeDocWithFeature('array', 'a1', { array: { source_body: '', count: 2, step_angle: 90 } })
    applyCompatibleSelection(doc, 'a1', 'body', 'array', '@body_1')
    expect((doc.features![0] as { array: { source_body: string } }).array?.source_body).toBe('@body_1')
  })

  it('resolves body: prefix to @ prefix for body fields', () => {
    const doc = makeDocWithFeature('delete_body', 'd1', { delete_body: { body: '' } })
    applyCompatibleSelection(doc, 'd1', 'body', 'delete_body', 'body:feat123')
    expect((doc.features![0] as { delete_body: { body: string } }).delete_body?.body).toBe('@body_feat123')
  })
})
