import type { Mutation } from '@/types/cad'

export function describeMutation(m: Mutation): string {
  switch (m.type) {
    case 'move_vertex':
      return `move vertex ${m.vertexKey} on ${m.entityId} in ${m.featureId}`
    case 'move_vertex_with_constraint':
      return `snap vertex ${m.vertexKey} on ${m.entityId} with ${m.constraintKind} constraint`
    case 'move_entity':
      return `move ${m.entityId} in ${m.featureId}`
    case 'add_constraint':
      return `add ${m.kind} constraint in ${m.featureId}`
    case 'set_constraint_value':
      return `set ${m.constraintId} value in ${m.featureId}`
    case 'set_constraint_pos':
      return `set ${m.constraintId} pos in ${m.featureId}`
    case 'delete':
      return `delete ${m.targets.length} element(s)`
    case 'add_entity':
      return `add ${m.kind} in ${m.featureId}`
    case 'add_entity_with_constraint':
      return `add ${m.kind} with ${m.constraintKind} constraint in ${m.featureId}`
    case 'add_projected_entity':
      return `add ${m.kind} from ${m.source} in ${m.featureId}`
    case 'add_point_at_intersection':
      return `add point at intersection in ${m.featureId}`
    case 'add_dock':
      return `materialize docked point in ${m.featureId}`
    case 'add_rect':
      return `add rect in ${m.featureId}`
    case 'add_center_rect':
      return `add center rect in ${m.featureId}`
    case 'add_ngon':
      return `add ${m.sides}-gon in ${m.featureId}`
    case 'apply_offset':
      return `offset ${m.sourceIds.length} entity(ies) by ${m.distance} in ${m.featureId}`
    case 'toggle_construction':
      return `toggle construction on ${m.targets.length} element(s)`
    case 'set_feature_plane':
      return `set plane of ${m.featureId} to ${m.plane}`
    case 'add_sketch':
      return `add ${m.label || m.featureId}`
    case 'delete_feature':
      return `delete feature ${m.featureId}`
    case 'set_feature_visibility':
      return `${m.visible ? 'show' : 'hide'} ${m.featureId}`
    case 'add_plane':
      return `add ${m.label || m.featureId}`
    case 'set_plane_definition_field':
      return `edit plane ${m.featureId}: ${m.field}`
    case 'rename_feature':
      return `rename ${m.featureId} to ${m.label}`
    case 'toggle_sketch_plane_visibility':
      return 'toggle sketch/plane visibility'
    case 'toggle_plane_visibility':
      return 'toggle plane visibility'
    case 'add_extrude':
      return `add extrude ${m.label ?? m.featureId}`
    case 'set_extrude_field':
      return `set extrude ${m.field} to ${m.value}`
    case 'add_extrude_profile':
      return `add extrude profile ${m.sketchQuery}`
    case 'remove_extrude_profile':
      return `remove extrude profile at index ${m.index}`
    case 'add_revolve':
      return `add revolve ${m.label ?? m.featureId}`
    case 'set_revolve_field':
      return `set revolve ${m.field} to ${m.value}`
    case 'add_revolve_profile':
      return `add revolve profile ${m.sketchQuery}`
    case 'remove_revolve_profile':
      return `remove revolve profile at index ${m.index}`
    case 'add_sweep':
      return `add sweep ${m.label ?? m.featureId}`
    case 'set_sweep_field':
      return `set sweep ${m.field} to ${m.value}`
    case 'add_sweep_profile':
      return `add sweep profile ${m.sketchQuery}`
    case 'remove_sweep_profile':
      return `remove sweep profile at index ${m.index}`
    case 'add_import_step':
      return `import STEP ${m.label ?? m.featureId}`
    case 'add_fillet':
      return `add fillet ${m.label ?? m.featureId}`
    case 'add_chamfer':
      return `add chamfer ${m.label ?? m.featureId}`
    case 'set_fillet_field':
      return `set fillet ${m.field} to ${m.value}`
    case 'set_chamfer_field':
      return `set chamfer ${m.field} to ${m.value}`
    case 'add_fillet_edge':
      return `add fillet edge ${m.edgeQuery}`
    case 'remove_fillet_edge':
      return `remove fillet edge at index ${m.index}`
    case 'add_chamfer_edge':
      return `add chamfer edge ${m.edgeQuery}`
    case 'remove_chamfer_edge':
      return `remove chamfer edge at index ${m.index}`
    case 'add_boolean':
      return `add boolean ${m.label ?? m.featureId}`
    case 'set_boolean_field':
      return `set boolean ${m.field} to ${m.value}`
    case 'add_boolean_tool':
      return `add boolean tool ${m.tool}`
    case 'remove_boolean_tool':
      return `remove boolean tool ${m.tool}`
    case 'add_array':
      return `add array ${m.label ?? m.featureId}`
    case 'set_array_field':
      return `set array ${m.field} to ${m.value}`
    case 'add_circular_array':
      return `add circular array ${m.label ?? m.featureId}`
    case 'set_circular_array_field':
      return `set circular array ${m.field} to ${m.value}`
    case 'add_delete_body':
      return `add delete body ${m.label ?? m.featureId}`
    case 'set_delete_body_field':
      return `set delete body ${m.field} to ${m.value}`
    case 'add_hole':
      return `add hole ${m.label ?? m.featureId}`
    case 'set_hole_field':
      return `set hole ${m.field} to ${m.value}`
    case 'add_transform':
      return `add transform ${m.label ?? m.featureId}`
    case 'set_transform_field':
      return `set transform ${m.field} to ${m.value}`
    case 'rename_part':
      return `rename ${m.bodyId} to ${m.name}`
    case 'set_part_color':
      return `set ${m.bodyId} color to ${m.color}`
    case 'set_part_transparency':
      return `set ${m.bodyId} transparency to ${m.transparency}`
    case 'set_part_metalness':
      return `set ${m.bodyId} metalness to ${m.metalness}`
    case 'set_part_roughness':
      return `set ${m.bodyId} roughness to ${m.roughness}`
    case 'set_part_transmission':
      return `set ${m.bodyId} transmission to ${m.transmission}`
    case 'add_mirror':
      return `add mirror ${m.label ?? m.featureId}`
    case 'set_mirror_field':
      return `set mirror ${m.field} to ${m.value}`
    case 'mirror_entities':
      return `mirror ${m.entityIds.length} entities in ${m.featureId}`
    case 'reorder_features':
      return `reorder ${m.featureId} to index ${m.toIndex}`
    case 'set_body_visibility':
      return `${m.visible ? 'show' : 'hide'} body ${m.bodyId}`
    case 'reorder_pick_field':
      return `reorder pick field ${m.field} in ${m.featureId}`
    case 'set_feature_suppression':
      return `${m.suppressed ? 'suppress' : 'unsuppress'} ${m.featureId}`
    case 'edit_session':
      return `edit session on ${m.featureId}`
    default:
      return 'unknown mutation'
  }
}
