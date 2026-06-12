import { describe, it, expect } from 'vitest'
import { mutationHandlers } from '@/hooks/mutationDispatch'

export const ALL_MUTATION_TYPES = [
  'move_vertex',
  'move_vertex_with_constraint',
  'move_entity',
  'add_constraint',
  'set_constraint_value',
  'set_constraint_pos',
  'delete',
  'add_entity',
  'add_entity_with_constraint',
  'add_projected_entity',
  'add_point_at_intersection',
  'add_dock',
  'add_rect',
  'add_center_rect',
  'add_ngon',
  'apply_offset',
  'toggle_construction',
  'set_feature_plane',
  'add_sketch',
  'delete_feature',
  'set_feature_visibility',
  'add_plane',
  'set_plane_definition_field',
  'rename_feature',
  'toggle_sketch_plane_visibility',
  'toggle_plane_visibility',
  'add_extrude',
  'set_extrude_field',
  'add_extrude_profile',
  'remove_extrude_profile',
  'add_revolve',
  'set_revolve_field',
  'add_revolve_profile',
  'remove_revolve_profile',
  'add_sweep',
  'set_sweep_field',
  'add_sweep_profile',
  'remove_sweep_profile',
  'add_import_step',
  'add_fillet',
  'add_chamfer',
  'set_fillet_field',
  'set_chamfer_field',
  'add_fillet_edge',
  'remove_fillet_edge',
  'add_chamfer_edge',
  'remove_chamfer_edge',
  'add_boolean',
  'set_boolean_field',
  'add_boolean_tool',
  'remove_boolean_tool',
  'add_array',
  'set_array_field',
  'add_circular_array',
  'set_circular_array_field',
  'set_body_visibility',
  'add_delete_body',
  'set_delete_body_field',
  'add_hole',
  'set_hole_field',
  'add_transform',
  'set_transform_field',
  'rename_part',
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
  'mirror_entities',
  'add_mirror',
  'set_mirror_field',
  'reorder_features',
  'reorder_pick_field',
  'set_feature_suppression',
  'edit_session',
]

describe('mutationDispatch', () => {
  it('handler table covers every Mutation type variant', () => {
    expect(Object.keys(mutationHandlers).sort()).toEqual(ALL_MUTATION_TYPES.slice().sort())
  })

  it('handler table is not empty', () => {
    expect(Object.keys(mutationHandlers).length).toBeGreaterThan(0)
  })

  it('returns undefined for unknown mutation type', () => {
    const handlers = mutationHandlers as Record<string, unknown>
    expect(handlers['__unknown_type__']).toBeUndefined()
  })
})
