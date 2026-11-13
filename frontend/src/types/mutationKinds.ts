// The mutations that can add a document-addressable id (a feature, an entity, a
// constraint). Shared by the session's created-id diff and the headless step
// outcome, because both need the same line between "a creator ran" and "a plain
// edit". A creator the applier refused leaves the document byte-identical, and
// that is a refusal the headless reply must name, not an ok step. A mutation
// outside this set is exempt: setting a field to the value it already has is a
// legitimate no-op, while a creator that adds nothing was refused.
import type { Mutation } from './cad'

export const CREATING_MUTATION_TYPES = new Set<Mutation['type']>([
  'add_constraint',
  'add_entity', 'add_entity_with_constraint', 'add_projected_entity', 'import_dxf', 'add_text',
  'add_rect', 'add_center_rect', 'add_ngon', 'add_three_point_arc', 'apply_offset',
  'mirror_entities', 'pattern_entities', 'fillet_corners',
  'add_sketch', 'add_plane', 'add_import_step',
  'add_extrude', 'add_revolve', 'add_sweep',
  'add_fillet', 'add_chamfer', 'add_boolean',
  'add_shell',
  'add_move_face',
  'add_delete_face',
  'add_pattern', 'add_delete_body', 'add_hole',
  'add_transform', 'add_mirror', 'add_split', 'add_variable', 'add_helix',
])
