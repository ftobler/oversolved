import type { Mutation } from '@/types/cad'

// Which mutations can write a value the document already holds, so a dispatch of
// one can leave it byte-identical. usePartDoc's handleMutation pays for the
// O(touched) deep compare on the true entries only: every other mutation adds,
// moves or removes content, so comparing it would be O(doc) waste on exactly the
// sketch drag path the guard exists to keep cheap.
//
// Total on purpose. The key type is Mutation['type'], so adding a variant to the
// union does not compile until someone classifies it here. That decision, guard
// this type or not, is the entire content of this table, and making it
// unavoidable is the point: it used to live only as prose, and a forgotten name
// failed silently as a dead undo entry, a wasted re-solve and a dirty flag set
// for an edit that changed nothing.
//
// The rule, stated once. true when the handler writes one already-held VALUE
// into a place the mutation names (a field, a flag, a label, a list position, a
// material entry), or removes by index or key that may already be gone. false
// for everything else, including the families below that can no-op but must not
// be guarded.
// `as const` is load-bearing, not decoration. `satisfies` enforces that every
// variant is classified, but the annotation it satisfies would also widen each
// entry to `boolean`, and the SLICE_READABLE_ASSERTION at the bottom reads the
// per-key LITERAL to work out which names are guarded. With the literals kept,
// that assertion has something real to check.
export const IDEMPOTENT_MUTATION = {
  // Labels and display flags: the doc may already carry the new value.
  rename_feature: true,
  rename_part: true,
  set_feature_visibility: true,
  set_body_visibility: true,
  set_feature_suppression: true,
  set_feature_plane: true,

  // The set_*_field family, one entry per feature kind. A repeated commit of an
  // in-progress drag or a blur-on-unchanged-input lands here.
  set_plane_definition_field: true,
  set_extrude_field: true,
  set_revolve_field: true,
  set_sweep_field: true,
  set_fillet_field: true,
  set_chamfer_field: true,
  set_boolean_field: true,
  set_array_field: true,
  set_circular_array_field: true,
  set_hole_field: true,
  set_transform_field: true,
  set_mirror_field: true,
  set_variable_field: true,

  // Constraint writes: the value, the drag position or the sign may be identical.
  set_constraint_value: true,
  set_constraint_pos: true,
  set_constraint_sign: true,

  // part_style material: the color popover applies on every click, not only when
  // a control moved, so the Apply button alone can dispatch a same-value write.
  set_part_color: true,
  set_part_transparency: true,
  set_part_metalness: true,
  set_part_roughness: true,
  set_part_transmission: true,

  // Reordering: dropping a row on its own slot, or picking it up and putting it
  // back, leaves the order identical.
  reorder_features: true,
  reorder_pick_field: true,

  // The rollback bar dragged to the position the doc already parks, or to the end
  // when the key is absent.
  set_rollback: true,

  // Removals by index or key, which can name something already gone: a splice
  // past the end and a filter that matches nothing both leave the feature
  // identical, and noOpSliceFor already slices the whole touched feature, so the
  // compare is O(feature) and covers each of these for free.
  // remove_dangling_content is the solve-derived cleanup, so its targets come from
  // the last solve and a stale-targets dispatch leaves a byte-identical doc;
  // noOpSliceFor reads the features its payload names, so it is O(touched) there.
  remove_dangling_content: true,
  remove_extrude_profile: true,
  remove_revolve_profile: true,
  remove_sweep_profile: true,
  remove_sweep_path: true,
  remove_fillet_edge: true,
  remove_chamfer_edge: true,
  remove_boolean_tool: true,
  remove_delete_body_ref: true,
  remove_transform_body: true,

  // ─── Deliberately excluded ───

  // Sketch authoring: every one appends or moves content, so it is a real edit by
  // construction and the compare is pure waste on the hot drag path.
  move_vertex: false,
  move_vertex_with_constraint: false,
  move_entity: false,
  resize_circle: false,
  add_entity: false,
  add_entity_with_constraint: false,
  add_projected_entity: false,
  add_rect: false,
  add_center_rect: false,
  add_ngon: false,
  apply_offset: false,

  // Structural edits. A resolved add_constraint appends a fresh unique id, and
  // toggle_construction flips the flag so re-dispatching it is a real change
  // (the same trap as the add_* family). delete names `kind:feature:entity`
  // targets across features, so its slice would have to cover every feature it
  // touches rather than the one field a setter narrows to.
  add_constraint: false,
  toggle_construction: false,
  delete: false,

  // Feature creation: each pushes a new row under an id the caller minted, so it
  // is never a value no-op.
  add_sketch: false,
  add_plane: false,
  add_import_step: false,
  add_extrude: false,
  add_revolve: false,
  add_sweep: false,
  add_fillet: false,
  add_chamfer: false,
  add_boolean: false,
  add_array: false,
  add_circular_array: false,
  add_delete_body: false,
  add_hole: false,
  add_transform: false,
  add_mirror: false,
  add_variable: false,

  // The add_* toggle family (add_*_profile, add_sweep_path, add_*_edge,
  // add_boolean_tool, add_delete_body_ref, add_transform_body): re-applying an
  // already-listed entry TOGGLES it back out, which is a real change, so a guard
  // would swallow the user's own click. It is the mirror image of the remove_*
  // block above.
  add_extrude_profile: false,
  add_revolve_profile: false,
  add_sweep_profile: false,
  add_sweep_path: false,
  add_fillet_edge: false,
  add_chamfer_edge: false,
  add_boolean_tool: false,
  add_delete_body_ref: false,
  add_transform_body: false,

  // Whole-feature delete and the global plane toggles. These CAN leave the doc
  // byte-identical (a delete of an absent or builtin id, a toggle with no
  // target), but the UI derives all three from the current doc, so a dispatch is
  // effectively unreachable and guarding them would buy nothing but the compare
  // on the hot path. The two toggles could not be guarded even in principle:
  // they carry no featureId at all, so they are not slice-readable and the
  // assertion below refuses the classification outright.
  delete_feature: false,
  toggle_plane_visibility: false,
  toggle_sketch_plane_visibility: false,

  // Undo-only carriers with empty handlers. The entry they push is the whole
  // point; there is no doc change to compare.
  edit_session: false,
  preview_commit: false,
} as const satisfies Record<Mutation['type'], boolean>

// The payload shapes usePartDoc's noOpSliceFor can read a mutation's target
// from, which is exactly the set of variants the guard is able to SEE a change
// of. A variant carrying none of them still produces a slice, but a degenerate
// one holding only doc.rollback, so it compares equal to itself and a real edit
// is swallowed: no undo entry, no dirty flag, no re-solve. Classifying such a
// variant as true in the table above has to be a compile error, and the
// assertion at the bottom of this file is what makes it one. Read together with
// the table, these two declarations are the guard's whole safety argument:
// classifying a variant is a decision, and this is the set of answers the guard
// can actually honour.
export type SliceReadableMutation =
  // read as the single feature it names
  | { featureId: string }
  // read as the single part_style entry it names
  | { bodyId: string }
  // read as the features its own cleanup plan names
  | { features: Record<string, { entities: string[]; constraints: string[] }> }
  // names no target of its own: the rollback mirror writes doc.rollback, which
  // every slice carries
  | { type: 'set_rollback' }

export type SliceReadableMutationType = Extract<Mutation, SliceReadableMutation>['type']

// The names the table above classifies as idempotent, recovered from its VALUES
// rather than restated, so it cannot fall out of step with the table.
type GuardedMutationType = {
  [K in Mutation['type']]: (typeof IDEMPOTENT_MUTATION)[K] extends true ? K : never
}[Mutation['type']]

// Assigning `true` fails to compile if a guarded name is not one the slice can
// read, which is the exact moment that name would start hiding its own change
// from the guard it is guarding. Plain union assignability is the check: every
// member of GuardedMutationType must be a member of SliceReadableMutationType.
const SLICE_READABLE_ASSERTION: GuardedMutationType extends SliceReadableMutationType ? true : false = true
// `void` reads the binding so noUnusedLocals accepts a check that exists only
// to be typed, matching the local precedent in yamlMutations/helpers.ts.
void SLICE_READABLE_ASSERTION
