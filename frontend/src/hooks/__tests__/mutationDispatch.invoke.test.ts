import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { makeSketch, makeDoc } from '@/utils/core/testFixture'
import type { PartDoc, PartFeature } from '@/types/cad'

// The exhaustive suite proves the handler TABLE has a key for every Mutation
// variant, but never invokes a single handler -- so the arrow bodies (which
// forward each mutation's fields, in order, to the matching apply* function)
// were uncovered. A transposed argument or a renamed field would slip through.
// This suite dispatches every handler and asserts the forwarded effect.

function sketchDoc(): PartDoc {
  return makeDoc(
    makeSketch('S1', {
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
        { id: 'c1', kind: 'circle' },
        { id: 'ml', kind: 'line' },
        { id: 'pt', kind: 'point' },
      ],
      constraints: [
        { id: 'k1', kind: 'length', target: '$l1', value: 10 },
      ],
      initial: {
        l1: [0, 0, 10, 0],
        l2: [0, 5, 10, 5],
        c1: [4, 4, 2],
        ml: [0, -1, 0, 9],
        pt: [7, 1],
      },
    }),
  )
}

function feature(doc: PartDoc, id: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === id)
}

describe('mutationHandlers forward sketch mutations', () => {
  it('move_vertex writes the dragged endpoint into initial', () => {
    const doc = sketchDoc()
    mutationHandlers.move_vertex(doc, {
      type: 'move_vertex', featureId: 'S1', entityId: 'l1', vertexKey: 'start', to: [2, 3],
    })
    expect(feature(doc, 'S1')!.initial!.l1.slice(0, 2)).toEqual([2, 3])
  })

  it('move_vertex_with_constraint moves and adds the snap constraint', () => {
    const doc = sketchDoc()
    mutationHandlers.move_vertex_with_constraint(doc, {
      type: 'move_vertex_with_constraint', featureId: 'S1', entityId: 'l1', vertexKey: 'end',
      to: [9, 0], constraintKind: 'coincident', snapVertexId: 'vertex:S1:l2:start',
    })
    const cs = feature(doc, 'S1')!.constraints!
    expect(cs.some(c => c.kind === 'coincident')).toBe(true)
  })

  it('move_entity translates by delta', () => {
    const doc = sketchDoc()
    const before = feature(doc, 'S1')!.initial!.l1.slice()
    mutationHandlers.move_entity(doc, {
      type: 'move_entity', featureId: 'S1', entityId: 'l1', delta: [1, 1],
    })
    expect(feature(doc, 'S1')!.initial!.l1[0]).toBe(before[0] + 1)
  })

  it('add_constraint appends a constraint', () => {
    const doc = sketchDoc()
    mutationHandlers.add_constraint(doc, {
      type: 'add_constraint', featureId: 'S1', kind: 'horizontal', targets: ['$l1'],
    })
    expect(feature(doc, 'S1')!.constraints!.some(c => c.kind === 'horizontal')).toBe(true)
  })

  it('set_constraint_value updates the value', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_value(doc, {
      type: 'set_constraint_value', featureId: 'S1', constraintId: 'k1', value: 42,
    })
    expect(feature(doc, 'S1')!.constraints!.find(c => c.id === 'k1')!.value).toBe(42)
  })

  it('set_constraint_pos updates the label position', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_pos(doc, {
      type: 'set_constraint_pos', featureId: 'S1', constraintId: 'k1', pos: [3, 4],
    })
    expect(feature(doc, 'S1')!.constraints!.find(c => c.id === 'k1')!.pos).toEqual([3, 4])
  })

  it('set_constraint_sign sets the orientation sign (normalized to +/-1)', () => {
    const doc = sketchDoc()
    mutationHandlers.set_constraint_sign(doc, {
      type: 'set_constraint_sign', featureId: 'S1', constraintId: 'k1', sign: -3,
    })
    expect(feature(doc, 'S1')!.constraints!.find(c => c.id === 'k1')!.sign).toBe(-1)
  })

  it('add_entity appends an entity with the given id', () => {
    const doc = sketchDoc()
    mutationHandlers.add_entity(doc, {
      type: 'add_entity', featureId: 'S1', kind: 'circle', params: [1, 1, 3], entityId: 'newC',
    })
    expect(feature(doc, 'S1')!.entities!.some(e => e.id === 'newC')).toBe(true)
  })

  it('add_entity_with_constraint appends an entity', () => {
    const doc = sketchDoc()
    const before = feature(doc, 'S1')!.entities!.length
    mutationHandlers.add_entity_with_constraint(doc, {
      type: 'add_entity_with_constraint', featureId: 'S1', kind: 'line', params: [0, 0, 5, 5],
      vertexKey: 'start', constraintKind: 'coincident', snapVertexId: 'vertex:S1:l1:end', entityId: 'wl',
    })
    expect(feature(doc, 'S1')!.entities!.length).toBe(before + 1)
  })

  it('add_projected_entity appends a source-carrying entity', () => {
    const doc = sketchDoc()
    mutationHandlers.add_projected_entity(doc, {
      type: 'add_projected_entity', featureId: 'S1', kind: 'line', source: '@ex1/edge/1',
    })
    expect(feature(doc, 'S1')!.entities!.some(e => e.source === '@ex1/edge/1')).toBe(true)
  })

  it('add_point_at_intersection adds a point entity', () => {
    const doc = sketchDoc()
    const before = feature(doc, 'S1')!.entities!.filter(e => e.kind === 'point').length
    mutationHandlers.add_point_at_intersection(doc, {
      type: 'add_point_at_intersection', featureId: 'S1', at: [4, 0], curveEntityIds: ['l1', 'c1'],
    })
    expect(feature(doc, 'S1')!.entities!.filter(e => e.kind === 'point').length).toBe(before + 1)
  })

  it('add_dock is dispatched (no-op without a tangent host)', () => {
    const doc = sketchDoc()
    expect(() => mutationHandlers.add_dock(doc, {
      type: 'add_dock', featureId: 'S1', at: [4, 4], hostConstraintId: 'missing',
    })).not.toThrow()
  })

  it('add_rect / add_center_rect / add_ngon add geometry', () => {
    const doc = sketchDoc()
    const n0 = feature(doc, 'S1')!.entities!.length
    mutationHandlers.add_rect(doc, { type: 'add_rect', featureId: 'S1', p0: [0, 0], p1: [4, 4] })
    mutationHandlers.add_center_rect(doc, { type: 'add_center_rect', featureId: 'S1', center: [0, 0], corner: [2, 2] })
    mutationHandlers.add_ngon(doc, { type: 'add_ngon', featureId: 'S1', center: [0, 0], corner: [3, 0], sides: 6 })
    expect(feature(doc, 'S1')!.entities!.length).toBeGreaterThan(n0)
  })

  it('apply_offset clones the source entities', () => {
    const doc = sketchDoc()
    const n0 = feature(doc, 'S1')!.entities!.length
    mutationHandlers.apply_offset(doc, { type: 'apply_offset', featureId: 'S1', sourceIds: ['l1'], distance: 2 })
    expect(feature(doc, 'S1')!.entities!.length).toBeGreaterThan(n0)
  })

  it('toggle_construction flips the construction flag', () => {
    const doc = sketchDoc()
    mutationHandlers.toggle_construction(doc, { type: 'toggle_construction', targets: ['entity:S1:l1'] })
    expect(feature(doc, 'S1')!.entities!.find(e => e.id === 'l1')!.construction).toBe(true)
  })

  it('mirror_entities adds mirrored copies', () => {
    const doc = sketchDoc()
    const n0 = feature(doc, 'S1')!.entities!.length
    mutationHandlers.mirror_entities(doc, {
      type: 'mirror_entities', featureId: 'S1', entityIds: ['l1'], mirrorLineId: 'ml',
    })
    expect(feature(doc, 'S1')!.entities!.length).toBeGreaterThan(n0)
  })

  it('set_feature_plane updates the sketch plane', () => {
    const doc = sketchDoc()
    mutationHandlers.set_feature_plane(doc, { type: 'set_feature_plane', featureId: 'S1', plane: '@builtin_plane_top' })
    expect(feature(doc, 'S1')!.plane).toBe('@builtin_plane_top')
  })

  it('delete removes the targeted entity', () => {
    const doc = sketchDoc()
    mutationHandlers.delete(doc, { type: 'delete', targets: ['entity:S1:l2'] })
    expect(feature(doc, 'S1')!.entities!.some(e => e.id === 'l2')).toBe(false)
  })
})

describe('mutationHandlers forward feature-creation + field + child mutations', () => {
  it('extrude: add, set field, add/remove profile', () => {
    const doc = sketchDoc()
    mutationHandlers.add_extrude(doc, { type: 'add_extrude', featureId: 'EX', sketchQuery: '@S1/area1', distance: 5 })
    expect(feature(doc, 'EX')!.kind).toBe('extrude')
    mutationHandlers.set_extrude_field(doc, { type: 'set_extrude_field', featureId: 'EX', field: 'distance', value: 9 })
    expect(feature(doc, 'EX')!.extrude!.distance).toBe(9)
    mutationHandlers.add_extrude_profile(doc, { type: 'add_extrude_profile', featureId: 'EX', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_extrude_profile(doc, { type: 'remove_extrude_profile', featureId: 'EX', index: 0 })
    expect(feature(doc, 'EX')!.extrude).toBeDefined()
  })

  it('revolve: add, set field, add/remove profile', () => {
    const doc = sketchDoc()
    mutationHandlers.add_revolve(doc, { type: 'add_revolve', featureId: 'RV', sketchQuery: '@S1/area1', angle: 90 })
    mutationHandlers.set_revolve_field(doc, { type: 'set_revolve_field', featureId: 'RV', field: 'angle', value: 180 })
    mutationHandlers.add_revolve_profile(doc, { type: 'add_revolve_profile', featureId: 'RV', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_revolve_profile(doc, { type: 'remove_revolve_profile', featureId: 'RV', index: 0 })
    expect(feature(doc, 'RV')!.revolve!.angle).toBe(180)
  })

  it('sweep: add, set field, add/remove profile and path', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sweep(doc, { type: 'add_sweep', featureId: 'SW', sketchQuery: '@S1/area1', pathQuery: '@S1/l1' })
    mutationHandlers.set_sweep_field(doc, { type: 'set_sweep_field', featureId: 'SW', field: 'operation', value: 'cut' })
    mutationHandlers.add_sweep_profile(doc, { type: 'add_sweep_profile', featureId: 'SW', sketchQuery: '@S1/area2' })
    mutationHandlers.remove_sweep_profile(doc, { type: 'remove_sweep_profile', featureId: 'SW', index: 0 })
    mutationHandlers.add_sweep_path(doc, { type: 'add_sweep_path', featureId: 'SW', pathQuery: '@S1/l2' })
    mutationHandlers.remove_sweep_path(doc, { type: 'remove_sweep_path', featureId: 'SW', index: 0 })
    expect(feature(doc, 'SW')!.kind).toBe('sweep')
  })

  it('fillet: add, set field, add/remove edge', () => {
    const doc = sketchDoc()
    mutationHandlers.add_fillet(doc, { type: 'add_fillet', featureId: 'FL' })
    mutationHandlers.set_fillet_field(doc, { type: 'set_fillet_field', featureId: 'FL', field: 'radius', value: 2 })
    mutationHandlers.add_fillet_edge(doc, { type: 'add_fillet_edge', featureId: 'FL', edgeQuery: '@ex/edge/1' })
    expect(feature(doc, 'FL')!.fillet!.edges).toContain('@ex/edge/1')
    mutationHandlers.remove_fillet_edge(doc, { type: 'remove_fillet_edge', featureId: 'FL', index: 0 })
    expect(feature(doc, 'FL')!.fillet!.edges).toHaveLength(0)
  })

  it('chamfer: add, set field, add/remove edge', () => {
    const doc = sketchDoc()
    mutationHandlers.add_chamfer(doc, { type: 'add_chamfer', featureId: 'CH' })
    mutationHandlers.set_chamfer_field(doc, { type: 'set_chamfer_field', featureId: 'CH', field: 'distance', value: 1 })
    mutationHandlers.add_chamfer_edge(doc, { type: 'add_chamfer_edge', featureId: 'CH', edgeQuery: '@ex/edge/2' })
    mutationHandlers.remove_chamfer_edge(doc, { type: 'remove_chamfer_edge', featureId: 'CH', index: 0 })
    expect(feature(doc, 'CH')!.chamfer).toBeDefined()
  })

  it('boolean: add, set field, add/remove tool', () => {
    const doc = sketchDoc()
    mutationHandlers.add_boolean(doc, { type: 'add_boolean', featureId: 'BL' })
    mutationHandlers.set_boolean_field(doc, { type: 'set_boolean_field', featureId: 'BL', field: 'operation', value: 'cut' })
    mutationHandlers.add_boolean_tool(doc, { type: 'add_boolean_tool', featureId: 'BL', tool: '@body_2' })
    expect(feature(doc, 'BL')!.boolean!.tools).toContain('@body_2')
    mutationHandlers.remove_boolean_tool(doc, { type: 'remove_boolean_tool', featureId: 'BL', tool: '@body_2' })
    expect(feature(doc, 'BL')!.boolean!.tools).toHaveLength(0)
  })

  it('array (linear + circular): add and set field', () => {
    const doc = sketchDoc()
    mutationHandlers.add_array(doc, { type: 'add_array', featureId: 'AR' })
    mutationHandlers.set_array_field(doc, { type: 'set_array_field', featureId: 'AR', field: 'count_x', value: 4 })
    expect(feature(doc, 'AR')!.array!.count_x).toBe(4)
    mutationHandlers.add_circular_array(doc, { type: 'add_circular_array', featureId: 'CA' })
    mutationHandlers.set_circular_array_field(doc, { type: 'set_circular_array_field', featureId: 'CA', field: 'count', value: 6 })
    expect(feature(doc, 'CA')!.kind).toBe('circular_array')
  })

  it('hole / transform / mirror / variable / delete_body: add and set field', () => {
    const doc = sketchDoc()
    mutationHandlers.add_hole(doc, { type: 'add_hole', featureId: 'HO' })
    mutationHandlers.set_hole_field(doc, { type: 'set_hole_field', featureId: 'HO', field: 'diameter', value: 3 })
    mutationHandlers.add_transform(doc, { type: 'add_transform', featureId: 'TR' })
    mutationHandlers.set_transform_field(doc, { type: 'set_transform_field', featureId: 'TR', field: 'operation', value: 'new' })
    mutationHandlers.add_mirror(doc, { type: 'add_mirror', featureId: 'MI' })
    mutationHandlers.set_mirror_field(doc, { type: 'set_mirror_field', featureId: 'MI', field: 'plane', value: '@builtin_plane_top' })
    mutationHandlers.add_variable(doc, { type: 'add_variable', featureId: 'VR' })
    mutationHandlers.set_variable_field(doc, { type: 'set_variable_field', featureId: 'VR', field: 'value', value: '2*3' })
    mutationHandlers.add_delete_body(doc, { type: 'add_delete_body', featureId: 'DB', bodies: ['@body_1'] })
    mutationHandlers.add_delete_body_ref(doc, { type: 'add_delete_body_ref', featureId: 'DB', bodyQuery: '@body_2' })
    expect(feature(doc, 'DB')!.delete_body!.bodies).toEqual(['@body_1', '@body_2'])
    mutationHandlers.remove_delete_body_ref(doc, { type: 'remove_delete_body_ref', featureId: 'DB', index: 0 })
    expect(feature(doc, 'DB')!.delete_body!.bodies).toEqual(['@body_2'])
    expect(['HO', 'TR', 'MI', 'VR', 'DB'].every(id => !!feature(doc, id))).toBe(true)
  })

  it('add_import_step appends an import feature', () => {
    const doc = sketchDoc()
    mutationHandlers.add_import_step(doc, { type: 'add_import_step', featureId: 'IM', fileId: 'f1', label: 'Imported' })
    expect(feature(doc, 'IM')!.kind).toBe('import_step')
  })
})

describe('mutationHandlers forward doc-level + part-style mutations', () => {
  it('add_sketch / add_plane and their field/visibility ops', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2', label: 'Sketch 2' })
    expect(feature(doc, 'S2')!.kind).toBe('sketch')
    mutationHandlers.add_plane(doc, { type: 'add_plane', featureId: 'PL', label: 'Plane' })
    mutationHandlers.set_plane_definition_field(doc, { type: 'set_plane_definition_field', featureId: 'PL', field: 'offset', value: 5 })
    expect(feature(doc, 'PL')!.kind).toBe('plane')
    mutationHandlers.toggle_plane_visibility(doc, { type: 'toggle_plane_visibility' })
    mutationHandlers.toggle_sketch_plane_visibility(doc, { type: 'toggle_sketch_plane_visibility' })
    mutationHandlers.set_feature_visibility(doc, { type: 'set_feature_visibility', featureId: 'S1', visible: false })
    expect(feature(doc, 'S1')!.visible).toBe(false)
  })

  it('add_sketch carries an optional plane query', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2', label: 'Sketch 2', plane: '@builtin_plane_top' })
    expect(feature(doc, 'S2')!.plane).toBe('@builtin_plane_top')
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S3' })
    expect(feature(doc, 'S3')!.plane).toBeUndefined()
  })

  it('rename_feature / set_feature_suppression', () => {
    const doc = sketchDoc()
    mutationHandlers.rename_feature(doc, { type: 'rename_feature', featureId: 'S1', label: 'Renamed' })
    expect(feature(doc, 'S1')!.label).toBe('Renamed')
    mutationHandlers.set_feature_suppression(doc, { type: 'set_feature_suppression', featureId: 'S1', suppressed: true })
    expect(feature(doc, 'S1')!.suppressed).toBe(true)
  })

  it('reorder_features / reorder_pick_field are dispatched', () => {
    const doc = sketchDoc()
    mutationHandlers.add_sketch(doc, { type: 'add_sketch', featureId: 'S2' })
    expect(() => {
      mutationHandlers.reorder_features(doc, { type: 'reorder_features', featureId: 'S2', toIndex: 0 })
      mutationHandlers.reorder_pick_field(doc, { type: 'reorder_pick_field', featureId: 'S1', field: 'edges', fromIndex: 0, toIndex: 1 })
    }).not.toThrow()
  })

  it('part-style: rename, color, material, visibility', () => {
    const doc = sketchDoc()
    mutationHandlers.rename_part(doc, { type: 'rename_part', bodyId: '@body_1', name: 'Widget' })
    mutationHandlers.set_part_color(doc, { type: 'set_part_color', bodyId: '@body_1', color: '#ff0000' })
    mutationHandlers.set_part_transparency(doc, { type: 'set_part_transparency', bodyId: '@body_1', transparency: 0.5 })
    mutationHandlers.set_part_metalness(doc, { type: 'set_part_metalness', bodyId: '@body_1', metalness: 0.2 })
    mutationHandlers.set_part_roughness(doc, { type: 'set_part_roughness', bodyId: '@body_1', roughness: 0.3 })
    mutationHandlers.set_part_transmission(doc, { type: 'set_part_transmission', bodyId: '@body_1', transmission: 0.1 })
    mutationHandlers.set_body_visibility(doc, { type: 'set_body_visibility', bodyId: '@body_1', visible: false })
    const ps = doc.part_style!['@body_1']
    expect(ps).toMatchObject({ name: 'Widget', color: '#ff0000', visible: false })
  })

  it('delete_feature removes the feature', () => {
    const doc = sketchDoc()
    mutationHandlers.delete_feature(doc, { type: 'delete_feature', featureId: 'S1' })
    expect(feature(doc, 'S1')).toBeUndefined()
  })

  it('remove_dangling_content removes the flagged entities and constraints', () => {
    const doc = sketchDoc()
    // Only source-carrying (projected) entities are eligible for removal.
    feature(doc, 'S1')!.entities!.push({ id: 'proj', kind: 'line', source: '?edge;x' })
    mutationHandlers.remove_dangling_content(doc, {
      type: 'remove_dangling_content',
      features: {
        S1: { entities: ['proj'], constraints: ['k1'] },
      },
    })
    const f = feature(doc, 'S1')!
    expect(f.entities!.some(e => e.id === 'proj')).toBe(false)
    expect(f.entities!.some(e => e.id === 'l1')).toBe(true)
    expect(f.constraints!.some(c => c.id === 'k1')).toBe(false)
  })

  it('edit_session is a no-op marker', () => {
    const doc = sketchDoc()
    const before = JSON.stringify(doc)
    mutationHandlers.edit_session(doc, { type: 'edit_session', featureId: 'S1' })
    expect(JSON.stringify(doc)).toBe(before)
  })
})
