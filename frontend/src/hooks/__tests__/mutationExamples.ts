// The mutation example registry: one (valid doc, real-effect mutation) pair per
// Mutation variant, keyed by type so the compiler refuses a missing one. It is
// seeded from usePartDoc.roundtrip.test.ts's ROUND_TRIPS (78 cases over 76
// types) and adds the eight types that table lacks (move_vertex,
// move_vertex_with_constraint, move_entity, resize_circle, delete_feature,
// set_rollback, edit_session, preview_commit), derived by diffing against
// mutationDispatch.exhaustive.test.ts's ALL_MUTATION_TYPES, plus the helix
// pair (add_helix, set_helix_field). The history
// property and transcript suites iterate this registry instead of a second
// hand-maintained list.
//
// Every example must change the doc when its handler runs, with two declared
// exceptions: label-only carriers (edit_session, preview_commit) write nothing
// and are asserted to be identity no-ops, and set_rollback's doc write comes
// from usePartDoc's rollback mirror reading the editor store, not from the
// no-op applier, so its effect is only observable through the hook.
import type { PartDoc, Mutation } from '@/types/cad'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

export interface MutationExample {
  // A fresh, valid document the mutation has a real effect on.
  makeDoc: () => PartDoc
  mutation: Mutation
  // A marker-only mutation whose handler writes no doc content: the undo entry
  // (and its label) is the whole effect, so the example asserts the identity
  // no-op instead of a doc change.
  labelOnly?: boolean
}

// ─── Doc builders ───

const emptyDoc = (): PartDoc => makeDoc()

const sketchDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
  constraints: [{ id: 'c1', kind: 'horizontal', target: '$l1' }],
}))

const circleDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'circ1', kind: 'circle' }, { id: 'ln1', kind: 'line' }],
  initial: { circ1: [5, 5, 3], ln1: [0, 0, 10, 0] },
  constraints: [],
}))

const extrudeDoc = (): PartDoc => makeDoc({
  id: 'ex1', kind: 'extrude', label: 'Ext',
  extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' },
})

const revolveDoc = (): PartDoc => makeDoc({
  id: 'rv1', kind: 'revolve', label: 'Rev',
  revolve: { sketch: ['@sk1'], angle: 360, axis: '@axis' },
})

const sweepDoc = (): PartDoc => makeDoc({
  id: 'sw1', kind: 'sweep', label: 'Sweep',
  sweep: { sketch: [], path: [] },
})

const filletDoc = (): PartDoc => makeDoc({
  id: 'f1', kind: 'fillet', label: 'Fillet',
  fillet: { edges: ['?e1', '?e2'], radius: 1 },
})

const chamferDoc = (): PartDoc => makeDoc({
  id: 'ch1', kind: 'chamfer', label: 'Chamfer',
  chamfer: { edges: [], distance: 1, kind: 'distance', angle: 45 },
})

const shellDoc = (): PartDoc => makeDoc({
  id: 'sh1', kind: 'shell', label: 'Shell',
  shell: { faces: [], thickness: 1, direction: 'inward' },
})

const loftDoc = (): PartDoc => makeDoc({
  id: 'lo1', kind: 'loft', label: 'Loft',
  loft: { profiles: [], ruled: false, operation: 'new' },
})

const moveFaceDoc = (): PartDoc => makeDoc({
  id: 'mf1', kind: 'move_face', label: 'Move Face',
  move_face: { faces: [], distance: 5 },
})

const booleanDoc = (): PartDoc => makeDoc({
  id: 'b1', kind: 'boolean', label: 'Boolean',
  boolean: { operation: 'union', target: '', tools: ['@t1'] },
})

const arrayDoc = (): PartDoc => makeDoc({
  id: 'a1', kind: 'array', label: 'Array',
  array: { mode: 'linear', count_x: 2, pitch_x: 20, operation: 'add', include_source: true },
})

const circularArrayDoc = (): PartDoc => makeDoc({
  id: 'ca1', kind: 'circular_array', label: 'Circular Array',
  circular_array: { count: 4, operation: 'add', include_source: true },
})

const holeDoc = (): PartDoc => makeDoc({
  id: 'h1', kind: 'hole', label: 'Hole',
  hole: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' },
})

const transformDoc = (): PartDoc => makeDoc({
  id: 't1', kind: 'transform', label: 'Transform',
  transform: { bodies: ['@b1', '@b2'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
})

const mirrorDoc = (): PartDoc => makeDoc({
  id: 'm1', kind: 'mirror', label: 'Mirror',
  mirror: { body: '', plane: '', keep_original: true, merge: true },
})

const variableDoc = (): PartDoc => makeDoc({
  id: 'v1', kind: 'variable', label: 'v1',
  variable: { expression: '0' },
})

const partStyleDoc = (): PartDoc => ({
  ...makeDoc(),
  part_style: { b1: { name: 'part 1', color: '#ff0000' } },
})

const helixDoc = (): PartDoc => makeDoc({
  id: 'hx1', kind: 'helix', label: 'Helix',
  helix: {
    reference: '@ex1/face/0', radius_mode: 'derived', mode: 'pitch_turns',
    pitch: 2, turns: 5, height: 10, helix_angle: 5, offset: 0, start_angle: 0,
    hand: 'right', direction: 'normal',
  },
})

const planeDoc = (): PartDoc => makeDoc({
  id: 'Top', kind: 'plane',
  definition: { mode: 'offset', plane: '@builtin_plane_front' },
})

const treeDoc = (): PartDoc => makeDoc(
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
  makeSketch('f1', { label: 'first' }),
  makeSketch('f2', { label: 'second' }),
)

const deleteBodyDoc = (): PartDoc => makeDoc(
  { id: 'ex1', kind: 'extrude', label: 'Ext', extrude: { sketch: [], distance: 1 } },
  { id: 'db1', kind: 'delete_body', label: 'Delete Body', delete_body: { bodies: ['@b1', '@b2'] } },
)

// The remove-by-index handlers need a non-empty list to splice, while the plain
// sweepDoc/chamferDoc start empty; these feed the remove round-trips.
const sweepPopulatedDoc = (): PartDoc => makeDoc({
  id: 'sw1', kind: 'sweep', label: 'Sweep',
  sweep: { sketch: ['@sk1'], path: ['@path1'] },
})

const chamferPopulatedDoc = (): PartDoc => makeDoc({
  id: 'ch1', kind: 'chamfer', label: 'Chamfer',
  chamfer: { edges: ['?e1'], distance: 1, kind: 'distance', angle: 45 },
})

const shellPopulatedDoc = (): PartDoc => makeDoc({
  id: 'sh1', kind: 'shell', label: 'Shell',
  shell: { faces: ['?f1'], thickness: 1, direction: 'inward' },
})

const loftPopulatedDoc = (): PartDoc => makeDoc({
  id: 'lo1', kind: 'loft', label: 'Loft',
  loft: { profiles: ['@sk1'], ruled: false, operation: 'new' },
})

const moveFacePopulatedDoc = (): PartDoc => makeDoc({
  id: 'mf1', kind: 'move_face', label: 'Move Face',
  move_face: { faces: ['?f1'], distance: 5 },
})

const deleteFaceDoc = (): PartDoc => makeDoc({
  id: 'df1', kind: 'delete_face', label: 'Delete Face',
  delete_face: { faces: [] },
})

const deleteFacePopulatedDoc = (): PartDoc => makeDoc({
  id: 'df1', kind: 'delete_face', label: 'Delete Face',
  delete_face: { faces: ['?f1'] },
})

// A projected entity (source-carrying) and a superfluous constraint, the two
// things remove_dangling_content is eligible to clean up.
const danglingDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [
    { id: 'l1', kind: 'line' },
    { id: 'proj1', kind: 'line', source: '?edge;x' },
  ],
  constraints: [{ id: 'c_super', kind: 'horizontal', target: '$l1' }],
}))

// ─── The registry ───

export const MUTATION_EXAMPLES: Record<Mutation['type'], MutationExample> = {
  // sketch
  move_vertex: {
    makeDoc: sketchDoc,
    mutation: { type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1], solvedGeometry: { l1: [1, 1, 10, 0], l2: [0.5, 5.5, 10, 5] } },
  },
  move_vertex_with_constraint: {
    makeDoc: sketchDoc,
    mutation: { type: 'move_vertex_with_constraint', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1], constraintKind: 'coincident', snapEntityRef: 'entity:sk1:l2', solvedGeometry: { l1: [1, 1, 10, 0], l2: [0.5, 5.5, 10, 5] } },
  },
  move_entity: {
    makeDoc: sketchDoc,
    mutation: { type: 'move_entity', featureId: 'sk1', entityId: 'l1', delta: [5, 0], solvedGeometry: { l1: [5, 0, 15, 0], l2: [5, 5, 15, 5] } },
  },
  resize_circle: {
    makeDoc: circleDoc,
    mutation: { type: 'resize_circle', featureId: 'sk1', entityId: 'circ1', radius: 7.5, solvedGeometry: { circ1: [5, 5, 7.5] } },
  },
  add_constraint: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l1:end', 'vertex:sk1:l2:start'] },
  },
  set_constraint_value: {
    makeDoc: sketchDoc,
    mutation: { type: 'set_constraint_value', featureId: 'sk1', constraintId: 'c1', value: 5 },
  },
  set_constraint_pos: {
    makeDoc: sketchDoc,
    mutation: { type: 'set_constraint_pos', featureId: 'sk1', constraintId: 'c1', pos: [1, 2] },
  },
  set_constraint_sign: {
    makeDoc: sketchDoc,
    mutation: { type: 'set_constraint_sign', featureId: 'sk1', constraintId: 'c1', sign: -1 },
  },
  delete: {
    makeDoc: sketchDoc,
    mutation: { type: 'delete', targets: ['entity:sk1:l2'] },
  },
  add_entity: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [1, 1, 2, 2], entityId: 'l3' },
  },
  add_entity_with_constraint: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_entity_with_constraint', featureId: 'sk1', kind: 'line', params: [1, 1, 2, 2], vertexKey: 'start', snapVertexId: 'vertex:sk1:l1:end', constraintKind: 'coincident', entityId: 'l3' },
  },
  add_projected_entity: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?edge;line', entityId: 'p1' },
  },
  add_rect: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [5, 5] },
  },
  add_center_rect: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [5, 5] },
  },
  add_ngon: {
    makeDoc: sketchDoc,
    mutation: { type: 'add_ngon', featureId: 'sk1', center: [0, 0], corner: [10, 0], sides: 6 },
  },
  apply_offset: {
    makeDoc: sketchDoc,
    mutation: { type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1'], distance: 2 },
  },
  toggle_construction: {
    makeDoc: sketchDoc,
    mutation: { type: 'toggle_construction', targets: ['entity:sk1:l2'] },
  },

  // extrude
  add_extrude: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 },
  },
  set_extrude_field: {
    makeDoc: extrudeDoc,
    mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 30 },
  },
  add_extrude_profile: {
    makeDoc: extrudeDoc,
    mutation: { type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '@sk3' },
  },
  remove_extrude_profile: {
    makeDoc: extrudeDoc,
    mutation: { type: 'remove_extrude_profile', featureId: 'ex1', index: 0 },
  },

  // revolve
  add_revolve: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_revolve', featureId: 'rv1', label: 'Rev', sketchQuery: '@sk1', angle: 180 },
  },
  set_revolve_field: {
    makeDoc: revolveDoc,
    mutation: { type: 'set_revolve_field', featureId: 'rv1', field: 'angle', value: 120 },
  },
  add_revolve_profile: {
    makeDoc: revolveDoc,
    mutation: { type: 'add_revolve_profile', featureId: 'rv1', sketchQuery: '@sk2' },
  },
  remove_revolve_profile: {
    makeDoc: revolveDoc,
    mutation: { type: 'remove_revolve_profile', featureId: 'rv1', index: 0 },
  },

  // sweep
  add_sweep: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_sweep', featureId: 'sw1', label: 'Sweep', sketchQuery: '@sk1', pathQuery: '@path1' },
  },
  set_sweep_field: {
    makeDoc: sweepDoc,
    mutation: { type: 'set_sweep_field', featureId: 'sw1', field: 'sketch', value: '@sk1' },
  },
  add_sweep_profile: {
    makeDoc: sweepPopulatedDoc,
    mutation: { type: 'add_sweep_profile', featureId: 'sw1', sketchQuery: '@sk2' },
  },
  remove_sweep_profile: {
    makeDoc: sweepPopulatedDoc,
    mutation: { type: 'remove_sweep_profile', featureId: 'sw1', index: 0 },
  },
  add_sweep_path: {
    makeDoc: sweepPopulatedDoc,
    mutation: { type: 'add_sweep_path', featureId: 'sw1', pathQuery: '@path2' },
  },
  remove_sweep_path: {
    makeDoc: sweepPopulatedDoc,
    mutation: { type: 'remove_sweep_path', featureId: 'sw1', index: 0 },
  },

  // fillet
  add_fillet: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_fillet', featureId: 'f1', label: 'Fillet' },
  },
  set_fillet_field: {
    makeDoc: filletDoc,
    mutation: { type: 'set_fillet_field', featureId: 'f1', field: 'radius', value: 3 },
  },
  add_fillet_edge: {
    makeDoc: filletDoc,
    mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e3' },
  },
  remove_fillet_edge: {
    makeDoc: filletDoc,
    mutation: { type: 'remove_fillet_edge', featureId: 'f1', index: 0 },
  },

  // chamfer
  add_chamfer: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_chamfer', featureId: 'ch1', label: 'Chamfer' },
  },
  set_chamfer_field: {
    makeDoc: chamferDoc,
    mutation: { type: 'set_chamfer_field', featureId: 'ch1', field: 'distance', value: 5 },
  },
  add_chamfer_edge: {
    makeDoc: chamferDoc,
    mutation: { type: 'add_chamfer_edge', featureId: 'ch1', edgeQuery: '?e1' },
  },
  remove_chamfer_edge: {
    makeDoc: chamferPopulatedDoc,
    mutation: { type: 'remove_chamfer_edge', featureId: 'ch1', index: 0 },
  },

  // shell
  add_shell: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_shell', featureId: 'sh1', label: 'Shell' },
  },
  set_shell_field: {
    makeDoc: shellDoc,
    mutation: { type: 'set_shell_field', featureId: 'sh1', field: 'thickness', value: 3 },
  },
  add_shell_face: {
    makeDoc: shellDoc,
    mutation: { type: 'add_shell_face', featureId: 'sh1', faceQuery: '?f1' },
  },
  remove_shell_face: {
    makeDoc: shellPopulatedDoc,
    mutation: { type: 'remove_shell_face', featureId: 'sh1', index: 0 },
  },

  // loft
  add_loft: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_loft', featureId: 'lo1', label: 'Loft' },
  },
  set_loft_field: {
    makeDoc: loftDoc,
    mutation: { type: 'set_loft_field', featureId: 'lo1', field: 'ruled', value: true },
  },
  add_loft_profile: {
    makeDoc: loftDoc,
    mutation: { type: 'add_loft_profile', featureId: 'lo1', sketchQuery: '@sk1' },
  },
  remove_loft_profile: {
    makeDoc: loftPopulatedDoc,
    mutation: { type: 'remove_loft_profile', featureId: 'lo1', index: 0 },
  },

  // move face
  add_move_face: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_move_face', featureId: 'mf1', label: 'Move Face' },
  },
  set_move_face_field: {
    makeDoc: moveFaceDoc,
    mutation: { type: 'set_move_face_field', featureId: 'mf1', field: 'distance', value: 3 },
  },
  add_move_face_ref: {
    makeDoc: moveFaceDoc,
    mutation: { type: 'add_move_face_ref', featureId: 'mf1', faceQuery: '?f1' },
  },
  remove_move_face_ref: {
    makeDoc: moveFacePopulatedDoc,
    mutation: { type: 'remove_move_face_ref', featureId: 'mf1', index: 0 },
  },
  // delete face
  add_delete_face: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_delete_face', featureId: 'df1', label: 'Delete Face' },
  },
  add_delete_face_ref: {
    makeDoc: deleteFaceDoc,
    mutation: { type: 'add_delete_face_ref', featureId: 'df1', faceQuery: '?f1' },
  },
  remove_delete_face_ref: {
    makeDoc: deleteFacePopulatedDoc,
    mutation: { type: 'remove_delete_face_ref', featureId: 'df1', index: 0 },
  },

  // boolean
  add_boolean: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_boolean', featureId: 'b1', label: 'Boolean' },
  },
  set_boolean_field: {
    makeDoc: booleanDoc,
    mutation: { type: 'set_boolean_field', featureId: 'b1', field: 'operation', value: 'subtract' },
  },
  add_boolean_tool: {
    makeDoc: booleanDoc,
    mutation: { type: 'add_boolean_tool', featureId: 'b1', tool: '@t2' },
  },
  remove_boolean_tool: {
    makeDoc: booleanDoc,
    mutation: { type: 'remove_boolean_tool', featureId: 'b1', tool: '@t1' },
  },

  // array
  add_array: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_array', featureId: 'a1', label: 'Array' },
  },
  set_array_field: {
    makeDoc: arrayDoc,
    mutation: { type: 'set_array_field', featureId: 'a1', field: 'count_x', value: 5 },
  },
  add_circular_array: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_circular_array', featureId: 'ca1', label: 'Circular Array' },
  },
  set_circular_array_field: {
    makeDoc: circularArrayDoc,
    mutation: { type: 'set_circular_array_field', featureId: 'ca1', field: 'count', value: 8 },
  },

  // hole
  add_hole: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_hole', featureId: 'h1', label: 'Hole' },
  },
  set_hole_field: {
    makeDoc: holeDoc,
    mutation: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 15 },
  },

  // transform
  add_transform: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_transform', featureId: 't1', label: 'Transform' },
  },
  set_transform_field: {
    makeDoc: transformDoc,
    mutation: { type: 'set_transform_field', featureId: 't1', field: 'scale', value: 2 },
  },
  add_transform_body: {
    makeDoc: transformDoc,
    mutation: { type: 'add_transform_body', featureId: 't1', bodyQuery: '@b3' },
  },
  remove_transform_body: {
    makeDoc: transformDoc,
    mutation: { type: 'remove_transform_body', featureId: 't1', index: 0 },
  },

  // mirror
  add_mirror: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_mirror', featureId: 'm1', label: 'Mirror' },
  },
  set_mirror_field: {
    makeDoc: mirrorDoc,
    mutation: { type: 'set_mirror_field', featureId: 'm1', field: 'plane', value: '@top' },
  },

  // variable
  add_variable: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_variable', featureId: 'v1', label: 'v1' },
  },
  set_variable_field: {
    makeDoc: variableDoc,
    mutation: { type: 'set_variable_field', featureId: 'v1', field: 'expression', value: '42' },
  },

  // helix
  add_helix: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_helix', featureId: 'hx1', label: 'Helix', reference: '@ex1/face/0' },
  },
  set_helix_field: {
    makeDoc: helixDoc,
    mutation: { type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: 8 },
  },

  // part style
  set_part_color: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' },
  },
  set_part_transparency: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 },
  },
  set_part_metalness: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_part_metalness', bodyId: 'b1', metalness: 0.5 },
  },
  set_part_roughness: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_part_roughness', bodyId: 'b1', roughness: 0.3 },
  },
  set_part_transmission: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_part_transmission', bodyId: 'b1', transmission: 0.2 },
  },
  rename_part: {
    makeDoc: partStyleDoc,
    mutation: { type: 'rename_part', bodyId: 'b1', name: 'renamed' },
  },
  set_body_visibility: {
    makeDoc: partStyleDoc,
    mutation: { type: 'set_body_visibility', bodyId: 'b1', visible: false },
  },

  // tree ops
  add_sketch: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Sketch 2' },
  },
  add_plane: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_plane', featureId: 'pl1', label: 'Plane 1' },
  },
  set_plane_definition_field: {
    makeDoc: planeDoc,
    mutation: { type: 'set_plane_definition_field', featureId: 'Top', field: 'offset', value: 15 },
  },
  rename_feature: {
    makeDoc: treeDoc,
    mutation: { type: 'rename_feature', featureId: 'f1', label: 'renamed' },
  },
  set_feature_plane: {
    makeDoc: treeDoc,
    mutation: { type: 'set_feature_plane', featureId: 'f1', plane: 'Front' },
  },
  set_feature_visibility: {
    makeDoc: treeDoc,
    mutation: { type: 'set_feature_visibility', featureId: 'f1', visible: false },
  },
  set_feature_suppression: {
    makeDoc: treeDoc,
    mutation: { type: 'set_feature_suppression', featureId: 'f1', suppressed: true },
  },
  reorder_features: {
    makeDoc: treeDoc,
    mutation: { type: 'reorder_features', featureId: 'f2', toIndex: 4 },
  },
  reorder_pick_field: {
    makeDoc: filletDoc,
    mutation: { type: 'reorder_pick_field', featureId: 'f1', field: 'edges', fromIndex: 0, toIndex: 1 },
  },
  toggle_sketch_plane_visibility: {
    makeDoc: sketchDoc,
    mutation: { type: 'toggle_sketch_plane_visibility' },
  },
  toggle_plane_visibility: {
    makeDoc: planeDoc,
    mutation: { type: 'toggle_plane_visibility' },
  },

  // delete body
  add_delete_body: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_delete_body', featureId: 'db1', bodies: ['@b1'], label: 'Delete Body' },
  },
  add_delete_body_ref: {
    makeDoc: deleteBodyDoc,
    mutation: { type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: '@b3' },
  },
  remove_delete_body_ref: {
    makeDoc: deleteBodyDoc,
    mutation: { type: 'remove_delete_body_ref', featureId: 'db1', index: 0 },
  },

  // import
  add_import_step: {
    makeDoc: emptyDoc,
    mutation: { type: 'add_import_step', featureId: 'imp1', fileId: 'file-1', label: 'part' },
  },

  // whole-feature delete: the doc carries a feature to remove
  delete_feature: {
    makeDoc: () => makeDoc(makeSketch('sk1'), { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } }),
    mutation: { type: 'delete_feature', featureId: 'ex1' },
  },

  // rollback: the no-op applier rides the mirror, which writes the store's
  // pre-synced position into the doc (see MutationExample's header).
  set_rollback: {
    makeDoc: () => makeDoc(makeSketch('sk1'), { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } }, { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } }),
    mutation: { type: 'set_rollback', position: 2 },
  },

  // cleanup: removes the projected entity and its superfluous constraint
  remove_dangling_content: {
    makeDoc: danglingDoc,
    mutation: { type: 'remove_dangling_content', features: { sk1: { entities: ['proj1'], constraints: ['c_super'] } } },
  },

  // label-only carriers: the entry they label is the whole effect
  edit_session: {
    makeDoc: emptyDoc,
    mutation: { type: 'edit_session', featureId: 'ex1' },
    labelOnly: true,
  },
  preview_commit: {
    makeDoc: emptyDoc,
    mutation: { type: 'preview_commit', description: 'apply previewed color' },
    labelOnly: true,
  },
}
