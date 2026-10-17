// Every command name the app binds or registers. A typo in a keymap, a toolbar
// button or a page command list is a compile error against this union, not a
// dev-only console warning. Adding a command means adding its name here first.
// The test in __tests__/commandNames.test.ts fails if a bound name is missing.
export const COMMAND_NAMES = [
  // Core keymap (CORE_KEYBINDINGS and the part/feature/assembly keymaps).
  'undo',
  'redo',
  'delete_selected',
  'cancel_draw',
  'cancel_edit',
  'toggle_construction',
  'toggle_sketch_plane_visibility',
  'toggle_plane_visibility',
  'add_extrude',
  'add_hole',
  'add_transform',
  'add_shell',
  'add_move_face',
  'add_delete_face',
  'apply_offset',
  'set_tool_mirror',

  // Sketch tools: set_tool_<activeTool>. Entity tools come from ENTITIES, the
  // rest are the compound and selection tools hardcoded in commandEntries.
  'set_tool_select',
  'set_tool_drag',
  'set_tool_line',
  'set_tool_circle',
  'set_tool_arc',
  'set_tool_ellipse',
  'set_tool_spline',
  'set_tool_point',
  'set_tool_project',
  'set_tool_rect',
  'set_tool_center_rect',
  'set_tool_ngon',
  'set_tool_dimension',

  // Constraints: apply_<kind>, one per CONSTRAINTS entry.
  'apply_horizontal',
  'apply_vertical',
  'apply_coincident',
  'apply_concentric',
  'apply_equal_length',
  'apply_parallel',
  'apply_normal',
  'apply_tangent',
  'apply_midpoint',
  'apply_fixed',
  'apply_colinear',
  'apply_length',
  'apply_radius',
  'apply_diameter',
  'apply_point_distance',
  'apply_point_distance_x',
  'apply_point_distance_y',
  'apply_line_distance',
  'apply_angle',
  'apply_radius_difference',

  // Assembly editor. Mate insertion is insert_mate_<MateKind>.
  'export_assembly',
  'insert_part_instance',
  'add_part',
  'duplicate_part',
  'delete_part',
  'set_part_visible',
  'set_builtin_visible',
  'set_part_fixed',
  'set_part_fixed_oneshot',
  'set_part_position',
  'set_part_rotation',
  'delete_mate',
  'update_mate',
  'reorder_part',
  'reorder_mate',
  'rename_mate',
  'insert_mate_fixed',
  'insert_mate_sliding',
  'insert_mate_rotating',
  'insert_mate_sliding_rotating',
  'insert_mate_spherical',
  'insert_mate_parallel',
  'insert_mate_parallel_plane_distance',
  'insert_mate_tangential',
  'insert_mate_copy_rotation',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

// The one narrowing point for names built from registry data: apply_<kind>,
// set_tool_<activeTool> and insert_mate_<kind>. Those inputs are open strings
// in the registries, so the cast cannot be avoided; the commandNames test
// checks every name built this way against COMMAND_NAMES.
export function narrowCommandName(name: string): CommandName {
  return name as CommandName
}
