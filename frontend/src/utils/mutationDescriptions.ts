import type { Mutation } from '../types/cad'

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
    case 'add_rect':
      return `add rect in ${m.featureId}`
    case 'add_center_rect':
      return `add center rect in ${m.featureId}`
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
    case 'set_extrude_distance':
      return `set extrude distance to ${m.distance}`
    case 'set_extrude_direction':
      return `set extrude direction to ${m.direction}`
    case 'set_extrude_operation':
      return `set extrude operation to ${m.operation}`
    case 'add_extrude_profile':
      return `add extrude profile ${m.sketchQuery}`
    case 'remove_extrude_profile':
      return `remove extrude profile at index ${m.index}`
    case 'add_revolve':
      return `add revolve ${m.label ?? m.featureId}`
    case 'set_revolve_angle':
      return `set revolve angle to ${m.angle}`
    case 'set_revolve_axis':
      return `set revolve axis to ${m.axis}`
    case 'set_revolve_operation':
      return `set revolve operation to ${m.operation}`
    case 'set_revolve_merge_target':
      return `set revolve merge target to ${m.mergeTarget}`
    case 'add_revolve_profile':
      return `add revolve profile ${m.sketchQuery}`
    case 'remove_revolve_profile':
      return `remove revolve profile at index ${m.index}`
    case 'add_import_step':
      return `import STEP ${m.label ?? m.featureId}`
    case 'add_fillet':
      return `add fillet ${m.label ?? m.featureId}`
    case 'add_chamfer':
      return `add chamfer ${m.label ?? m.featureId}`
    case 'set_fillet_radius':
      return `set fillet radius to ${m.radius}`
    case 'set_chamfer_distance':
      return `set chamfer distance to ${m.distance}`
    case 'set_chamfer_angle':
      return `set chamfer angle to ${m.angle}`
    case 'set_chamfer_kind':
      return `set chamfer kind to ${m.kind}`
    case 'add_fillet_edge':
      return `add fillet edge ${m.edgeQuery}`
    case 'remove_fillet_edge':
      return `remove fillet edge at index ${m.index}`
    case 'add_chamfer_edge':
      return `add chamfer edge ${m.edgeQuery}`
    case 'remove_chamfer_edge':
      return `remove chamfer edge at index ${m.index}`
    case 'add_array':
      return `add array ${m.label ?? m.featureId}`
    case 'set_array_mode':
      return `set array mode to ${m.mode}`
    case 'set_array_source_body':
      return `set array source body to ${m.sourceBody}`
    case 'set_array_operation':
      return `set array operation to ${m.operation}`
    case 'set_array_include_source':
      return `set array include source to ${m.includeSource}`
    case 'set_array_count_x':
      return `set array count_x to ${m.count}`
    case 'set_array_pitch_x':
      return `set array pitch_x to ${m.pitch}`
    case 'set_array_direction_x_query':
      return `set array direction_x query to ${m.query}`
    case 'set_array_count_y':
      return `set array count_y to ${m.count}`
    case 'set_array_pitch_y':
      return `set array pitch_y to ${m.pitch}`
    case 'set_array_direction_y_query':
      return `set array direction_y query to ${m.query}`
    case 'set_array_count':
      return `set array count to ${m.count}`
    case 'set_array_step_angle':
      return `set array step angle to ${m.stepAngle}`
    case 'set_array_axis':
      return `set array axis to ${m.axis}`
    case 'set_array_direction_x':
      return `set array direction_x to ${m.direction_x}`
    case 'set_array_direction_y':
      return `set array direction_y to ${m.direction_y}`
    case 'add_delete_body':
      return `add delete body ${m.label ?? m.featureId}`
    case 'set_delete_body_target':
      return `set delete body target to ${m.body}`
    case 'add_hole':
      return `add hole ${m.label ?? m.featureId}`
    case 'set_hole_sketch':
      return `set hole sketch to ${m.sketch}`
    case 'set_hole_diameter':
      return `set hole diameter to ${m.diameter}`
    case 'set_hole_depth':
      return `set hole depth to ${m.depth}`
    case 'set_hole_depth_mode':
      return `set hole depth mode to ${m.depthMode}`
    case 'set_hole_direction':
      return `set hole direction to ${m.direction}`
    case 'set_hole_target':
      return `set hole target to ${m.target}`
    case 'add_transform':
      return `add transform ${m.label ?? m.featureId}`
    case 'set_transform_field':
      return `set transform ${m.field} to ${m.value}`
    case 'rename_part':
      return `rename ${m.bodyId} to ${m.name}`
    case 'set_part_color':
      return `set ${m.bodyId} color to ${m.color}`
    default:
      return 'unknown mutation'
  }
}
