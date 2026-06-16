import type { FeatureEditorSchema } from './FeatureEditor'
import {
  normalizeExtrudeSketch,
  normalizeRevolveSketch,
  normalizeSweepSketch,
  normalizeSweepPath,
} from '@/utils/yamlMutations'
import { resolveBodyMergeRef, resolveAxisQuery } from '@/utils/query/resolveBodyPickRef'

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

function parseVector3(text: string): [number, number, number] | null {
  const parts = text.split(',').map(s => parseFloat(s.trim()))
  if (parts.length === 3 && parts.every(p => !isNaN(p))) return parts as [number, number, number]
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaData = Record<string, any>

const showMergeTarget = (d: SchemaData) => d.operation !== 'new'

export const EXTRUDE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_extrude',
  subKey: 'extrude',
  defaults: { sketch: [], distance: 10, direction: 'normal' },
  normalize: (raw) => ({ ...raw, sketch: normalizeExtrudeSketch(raw.sketch) }),
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
      showWhen: showMergeTarget, transform: resolveBodyMergeRef, removeValue: undefined,
      emptyText: '(all bodies)' },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }, { value: 'symmetric', label: 'Symmetric' }] },
  ],
}

export const REVOLVE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_revolve',
  subKey: 'revolve',
  defaults: { sketch: [], angle: 360 },
  normalize: (raw) => ({ ...raw, sketch: normalizeRevolveSketch(raw.sketch) }),
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
      showWhen: showMergeTarget, transform: resolveBodyMergeRef, removeValue: undefined,
      emptyText: '(all bodies)' },
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery },
  ],
}

export const SWEEP_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_sweep',
  subKey: 'sweep',
  defaults: { sketch: [], path: [] },
  normalize: (raw) => ({ ...raw, sketch: normalizeSweepSketch(raw.sketch), path: normalizeSweepPath(raw.path) }),
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
      showWhen: showMergeTarget, transform: resolveBodyMergeRef, removeValue: undefined,
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
  defaults: { mode: 'linear', operation: 'add', include_source: true, direction_x: [1, 0, 0], count_x: 2, pitch_x: 20 },
  fields: [
    { type: 'select', key: 'mode', label: 'Mode', default: 'linear',
      options: [{ value: 'linear', label: 'Linear' }, { value: 'rectangular', label: 'Rectangular' }] },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'new', label: 'New' }] },
    { type: 'checkbox', key: 'include_source', label: 'Include src', default: true },
    { type: 'text', key: 'direction_x', label: 'Direction X', default: '1, 0, 0',
      parse: parseVector3, validate: (v) => Array.isArray(v) && v.length === 3 },
    { type: 'number', key: 'count_x', label: 'Count X', default: 2, parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'number', key: 'pitch_x', label: 'Pitch X', default: 20, validate: (v) => v >= 0, min: 0 },
    { type: 'text', key: 'direction_y', label: 'Direction Y', default: '0, 1, 0',
      showWhen: (d) => d.mode === 'rectangular', parse: parseVector3, validate: (v) => Array.isArray(v) && v.length === 3 },
    { type: 'number', key: 'count_y', label: 'Count Y', default: 2,
      showWhen: (d) => d.mode === 'rectangular', parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'number', key: 'pitch_y', label: 'Pitch Y', default: 20,
      showWhen: (d) => d.mode === 'rectangular', validate: (v) => v >= 0, min: 0 },
  ],
}

export const CIRCULAR_ARRAY_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_circular_array',
  subKey: 'circular_array',
  defaults: { operation: 'add', include_source: true, count: 4 },
  fields: [
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'new', label: 'New' }] },
    { type: 'checkbox', key: 'include_source', label: 'Include src', default: true },
    { type: 'number', key: 'count', label: 'Count', default: 4, parse: 'int', validate: (v) => v > 0, min: 1 },
    { type: 'checkbox', key: '_evenly_spaced', label: 'Evenly spaced', default: true,
      isChecked: (d) => d.step_angle == null,
      getMutation: (checked, d) => ({ field: 'step_angle', value: checked ? null : (360 / (d.count ?? 4)) }) },
    { type: 'number', key: 'step_angle', label: 'Step angle',
      showWhen: (d) => d.step_angle != null },
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery },
  ],
}

export const DELETE_BODY_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_delete_body',
  subKey: 'delete_body',
  defaults: { body: '' },
  fields: [
    { type: 'pick', key: 'body', label: 'Body' },
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
