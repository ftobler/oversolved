import type { FeatureEditorSchema } from './FeatureEditor'
import {
  normalizeRefList,
} from '@/utils/yamlMutations'
import { resolveBodyPickRef, resolveAxisQuery } from '@/utils/query/resolveBodyPickRef'

function stripFacePrefix(selectionId: string): string {
  return selectionId.startsWith('face:') ? selectionId.split(':').slice(2).join(':') : selectionId
}

function stripFaceOrEdgePrefix(selectionId: string): string {
  if (selectionId.startsWith('face:') || selectionId.startsWith('edge:')) return selectionId.split(':').slice(2).join(':')
  return selectionId
}

function resolveTransformQuery(selectionId: string): string {
  if (selectionId.startsWith('face:')) return selectionId.split(':').slice(2).join(':')
  if (selectionId.startsWith('entity:')) return '@' + selectionId.split(':').slice(1).join('/')
  if (selectionId.startsWith('vertex:')) return '@' + selectionId.split(':').slice(1).join('/')
  return selectionId
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaData = Record<string, any>

const showMergeTarget = (d: SchemaData) => d.operation !== 'new'

export const EXTRUDE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_extrude',
  subKey: 'extrude',
  defaults: { sketch: [], distance: 10, direction: 'normal' },
  normalize: (raw) => ({ ...raw, sketch: normalizeRefList(raw.sketch) }),
  fields: [
    { type: 'pick', key: 'sketch', label: 'Profile', multi: true,
      addMutationType: 'add_extrude_profile', addValueKey: 'sketchQuery',
      removeMutationType: 'remove_extrude_profile' },
    { type: 'select', key: 'termination', label: 'Termination', default: 'blind',
      options: [{ value: 'blind', label: 'Blind' }, { value: 'up_to', label: 'Up to' }] },
    { type: 'pick', key: 'up_to', label: 'Up to',
      showWhen: (d) => d.termination === 'up_to',
      transform: stripFaceOrEdgePrefix, removeValue: undefined,
      emptyText: '(pick plane, point, or face)' },
    { type: 'number', key: 'distance', label: 'Distance', default: 10,
      showWhen: (d) => d.termination !== 'up_to', validate: (v) => v > 0 },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, removeValue: undefined,
      emptyText: '(all bodies)' },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }, { value: 'symmetric', label: 'Symmetric' }] },
  ],
}

export const REVOLVE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_revolve',
  subKey: 'revolve',
  defaults: { sketch: [], angle: 360 },
  normalize: (raw) => ({ ...raw, sketch: normalizeRefList(raw.sketch) }),
  fields: [
    { type: 'pick', key: 'sketch', label: 'Profile', multi: true,
      addMutationType: 'add_revolve_profile', addValueKey: 'sketchQuery',
      removeMutationType: 'remove_revolve_profile' },
    { type: 'number', key: 'angle', label: 'Angle', default: 360, validate: (v) => v > 0 },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }, { value: 'symmetric', label: 'Symmetric' }] },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, removeValue: undefined,
      emptyText: '(all bodies)' },
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery },
  ],
}

export const SWEEP_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_sweep',
  subKey: 'sweep',
  defaults: { sketch: [], path: [] },
  normalize: (raw) => ({ ...raw, sketch: normalizeRefList(raw.sketch), path: normalizeRefList(raw.path) }),
  fields: [
    { type: 'pick', key: 'path', label: 'Path', multi: true,
      addMutationType: 'add_sweep_path', addValueKey: 'pathQuery',
      removeMutationType: 'remove_sweep_path', transform: stripFacePrefix },
    { type: 'pick', key: 'sketch', label: 'Profile', multi: true,
      addMutationType: 'add_sweep_profile', addValueKey: 'sketchQuery',
      removeMutationType: 'remove_sweep_profile', transform: stripFacePrefix },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, removeValue: undefined,
      emptyText: '(all bodies)' },
  ],
}

export const FILLET_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_fillet',
  subKey: 'fillet',
  defaults: { edges: [], radius: 1 },
  fields: [
    { type: 'pick', key: 'edges', label: 'Edges', multi: true,
      addMutationType: 'add_fillet_edge', addValueKey: 'edgeQuery',
      removeMutationType: 'remove_fillet_edge',
      validatePick: (id) => id.startsWith('?') },
    { type: 'number', key: 'radius', label: 'Radius', default: 1, validate: (v) => v > 0 },
  ],
}

export const CHAMFER_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_chamfer',
  subKey: 'chamfer',
  defaults: { edges: [], distance: 1, kind: 'distance', angle: 45 },
  fields: [
    { type: 'pick', key: 'edges', label: 'Edges', multi: true,
      addMutationType: 'add_chamfer_edge', addValueKey: 'edgeQuery',
      removeMutationType: 'remove_chamfer_edge',
      validatePick: (id) => id.startsWith('?') },
    { type: 'select', key: 'kind', label: 'Kind', default: 'distance',
      options: [{ value: 'distance', label: 'Distance' }, { value: 'angle_distance', label: 'Angle + Distance' }] },
    { type: 'number', key: 'distance', label: 'Distance', default: 1, validate: (v) => v > 0 },
    { type: 'number', key: 'angle', label: 'Angle', default: 45,
      showWhen: (d) => d.kind === 'angle_distance', validate: (v) => v > 0 },
  ],
}

export const BOOLEAN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_boolean',
  subKey: 'boolean',
  defaults: { operation: 'union', target: '', tools: [] },
  fields: [
    { type: 'select', key: 'operation', label: 'Operation', default: 'union',
      options: [{ value: 'union', label: 'Union' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }] },
    { type: 'pick', key: 'target', label: 'Target', emptyText: '(pick target)' },
    { type: 'pick', key: 'tools', label: 'Tools', multi: true,
      addMutationType: 'add_boolean_tool', addValueKey: 'tool',
      removeMutationType: 'remove_boolean_tool', removeKey: 'tool', removeValueIsIndex: false },
    { type: 'checkbox', key: 'keep_tools', label: 'Keep tools', default: false },
  ],
}

export const HOLE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_hole',
  subKey: 'hole',
  defaults: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' },
  fields: [
    { type: 'pick', key: 'sketch', label: 'Sketch', transform: stripFacePrefix },
    { type: 'number', key: 'diameter', label: 'Diameter', default: 10, validate: (v) => v > 0, unit: 'mm' },
    { type: 'select', key: 'depth_mode', label: 'Depth mode', default: 'blind',
      options: [{ value: 'blind', label: 'Blind' }, { value: 'through_all', label: 'Through All' }] },
    { type: 'number', key: 'depth', label: 'Depth', default: 20,
      showWhen: (d) => d.depth_mode === 'blind', validate: (v) => v > 0, unit: 'mm' },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }] },
  ],
}

export const TRANSFORM_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_transform',
  subKey: 'transform',
  defaults: { body: '', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
  fields: [
    { type: 'pick', key: 'body', label: 'Body' },
    { type: 'select', key: 'operation', label: 'Operation', default: 'new',
      options: [{ value: 'new', label: 'New' }, { value: 'replace', label: 'Replace' }] },
    { type: 'number', key: 'translation', label: 'X', arrayField: 'translation', arrayIndex: 0, default: 0 },
    { type: 'number', key: 'translation', label: 'Y', arrayField: 'translation', arrayIndex: 1, default: 0 },
    { type: 'number', key: 'translation', label: 'Z', arrayField: 'translation', arrayIndex: 2, default: 0 },
    { type: 'number', key: 'rotation_angle', label: 'Angle (deg)', default: 0 },
    { type: 'pick', key: 'rotation_axis', label: 'Axis', transform: resolveTransformQuery },
    { type: 'number', key: 'scale', label: 'Factor', default: 1 },
    { type: 'pick', key: 'scale_center_from', label: 'Origin', transform: resolveTransformQuery },
  ],
}

export const MIRROR_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_mirror',
  subKey: 'mirror',
  defaults: { body: '', plane: '', keep_original: true, merge: true },
  fields: [
    { type: 'pick', key: 'body', label: 'Body' },
    { type: 'pick', key: 'plane', label: 'Mirror Plane', transform: stripFacePrefix },
    { type: 'checkbox', key: 'keep_original', label: 'Keep Original', default: true },
    { type: 'checkbox', key: 'merge', label: 'Merge', default: true },
  ],
}

export const ARRAY_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_array',
  subKey: 'array',
  // The array direction now comes solely from the picked geometry
  // (direction_x_query / direction_y_query); there is no raw-vector fallback, so
  // an unpicked direction is a solve error rather than a silent world-axis array.
  defaults: { source_body: '', mode: 'linear', operation: 'add', include_source: true, count_x: 2, pitch_x: 20 },
  fields: [
    { type: 'select', key: 'mode', label: 'Mode', default: 'linear',
      options: [{ value: 'linear', label: 'Linear' }, { value: 'rectangular', label: 'Rectangular' }] },
    // Empty means "the first body in the store", which is what the solver falls back to.
    { type: 'pick', key: 'source_body', label: 'Body', transform: resolveBodyPickRef,
      emptyText: '(first body)' },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'new', label: 'New' }] },
    { type: 'checkbox', key: 'include_source', label: 'Include src', default: true },
    // A direction pick is required: an edge sets its own direction, a planar face
    // its normal. `invert_x` flips whichever was picked.
    { type: 'pick', key: 'direction_x_query', label: 'Direction X', transform: resolveAxisQuery,
      emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert_x', label: 'Invert X', default: false },
    { type: 'number', key: 'count_x', label: 'Count X', default: 2, parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'number', key: 'pitch_x', label: 'Pitch X', default: 20, validate: (v) => v >= 0, min: 0 },
    { type: 'pick', key: 'direction_y_query', label: 'Direction Y', transform: resolveAxisQuery,
      showWhen: (d) => d.mode === 'rectangular', emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert_y', label: 'Invert Y', default: false,
      showWhen: (d) => d.mode === 'rectangular' },
    { type: 'number', key: 'count_y', label: 'Count Y', default: 2,
      showWhen: (d) => d.mode === 'rectangular', parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'number', key: 'pitch_y', label: 'Pitch Y', default: 20,
      showWhen: (d) => d.mode === 'rectangular', validate: (v) => v >= 0, min: 0 },
  ],
}

export const CIRCULAR_ARRAY_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_circular_array',
  subKey: 'circular_array',
  defaults: { source_body: '', operation: 'add', include_source: true, count: 4 },
  fields: [
    // Empty means "the first body in the store", which is what the solver falls back to.
    { type: 'pick', key: 'source_body', label: 'Body', transform: resolveBodyPickRef,
      emptyText: '(first body)' },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'new', label: 'New' }] },
    { type: 'checkbox', key: 'include_source', label: 'Include src', default: true },
    { type: 'number', key: 'count', label: 'Count', default: 4, parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'checkbox', key: '_evenly_spaced', label: 'Evenly spaced', default: true,
      isChecked: (d) => d.step_angle == null,
      getMutation: (checked, d) => ({ field: 'step_angle', value: checked ? null : (360 / (d.count ?? 4)) }) },
    { type: 'number', key: 'step_angle', label: 'Step angle',
      showWhen: (d) => d.step_angle != null },
    // An axis pick is required: an edge is the rotation axis, a planar face its
    // normal. `invert_axis` flips the axis, reversing the sweep sense.
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery,
      emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert_axis', label: 'Invert axis', default: false },
  ],
}

export const DELETE_BODY_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_delete_body',
  subKey: 'delete_body',
  defaults: { bodies: [] },
  fields: [
    // Deliberately NO transform, unlike every other body-naming field. Those are
    // singular by contract, so `resolveBodyPickRef` coercing a feature ref `@ex1`
    // to the body id `@body_ex1` is right for them. This field is the plural one:
    // `@ex1` here means every body that feature made, split siblings included
    // (kernel/features/deleteBody.ts), and that coercion would silently narrow it
    // to the first sibling -- deleting half a severed part and reporting success.
    // A face pick is body-exact already and resolves in the kernel.
    { type: 'pick', key: 'bodies', label: 'Bodies', multi: true,
      addMutationType: 'add_delete_body_ref', addValueKey: 'bodyQuery',
      removeMutationType: 'remove_delete_body_ref',
      emptyText: '(pick one or more bodies)' },
  ],
}

export const VARIABLE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_variable',
  subKey: 'variable',
  defaults: { expression: '0' },
  fields: [
    // Plain text (not ExpressionInput): a variable expression may reference other
    // variables the editor cannot resolve locally, so we must not eval-and-revert.
    { type: 'text', key: 'expression', label: 'Expression', default: '0' },
  ],
}

export const EDITOR_SCHEMAS: Record<string, FeatureEditorSchema> = {
  extrude: EXTRUDE_SCHEMA,
  revolve: REVOLVE_SCHEMA,
  sweep: SWEEP_SCHEMA,
  fillet: FILLET_SCHEMA,
  chamfer: CHAMFER_SCHEMA,
  boolean: BOOLEAN_SCHEMA,
  hole: HOLE_SCHEMA,
  transform: TRANSFORM_SCHEMA,
  mirror: MIRROR_SCHEMA,
  array: ARRAY_SCHEMA,
  circular_array: CIRCULAR_ARRAY_SCHEMA,
  delete_body: DELETE_BODY_SCHEMA,
  variable: VARIABLE_SCHEMA,
}
