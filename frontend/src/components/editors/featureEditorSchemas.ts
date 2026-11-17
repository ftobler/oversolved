import type { FeatureEditorSchema } from './FeatureEditor'
import type { EditorFieldDef, HintContext, ReadonlyFieldDef, TextFieldDef } from './widgets/fieldTypes'
import {
  normalizeRefList,
  DEFAULT_EXTRUDE_DISTANCE,
} from '@/utils/yamlMutations'
import { THREAD_TABLE, threadEntry, threadLabel, threadDesignations, DRILL_POINT_ANGLE } from '@/kernel/threadTable'
import { pickedSketchEntity } from '@/kernel/features/shared/bodyRef'
import { circleDrillSiteReason } from '@/kernel/features/shared/drillSite'
import type { PartFeature, ThreadSpec } from '@/types/cad'
import { resolveBodyPickRef, resolveAxisQuery } from '@/utils/query/resolveBodyPickRef'
import { stripSelectionWrapper } from '@/utils/query/selectionId'
import { positive, nonNegative, finite, between } from '@/utils/core/valueRules'
import { arrayCountProblem, MAX_ARRAY_COUNT } from '@/persistence/docSchema'
import { patternSubject } from '@/utils/core/patternSubject'
import { formatSkipList, parseSkipList, SKIP_LIST_TITLE, type SkipEntry } from '@/utils/core/patternSkip'
import { LINEAR_DIRECTION_MODES, LINEAR_DIRECTION_MODE_LABELS } from '@/utils/core/linearPatternModes'
import { solvedNumber } from '@/utils/core/solvedValue'
import {
  filterSkippedInstances,
  generatedCount,
  instanceIndices,
  instanceSummary,
  rectangularIndices,
  toInstances,
} from '@/kernel/features/patternInstances'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema data is a heterogeneous bag of editor values
type SchemaData = Record<string, any>

const showMergeTarget = (d: SchemaData) => d.operation !== 'new'

/** Whether a stored angle asks for a draft. An expression counts as set, the
 *  same rule the drive boundary applies: the editor cannot evaluate it here. */
const angleIsSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '' && !(typeof value === 'number' && value === 0)

export const EXTRUDE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_extrude',
  subKey: 'extrude',
  defaults: { sketch: [], distance: DEFAULT_EXTRUDE_DISTANCE, direction: 'normal' },
  normalize: (raw) => ({ ...raw, sketch: normalizeRefList(raw.sketch) }),
  fields: [
    { type: 'pick', key: 'sketch', label: 'Profile', multi: true,
      addMutationType: 'add_extrude_profile', addValueKey: 'sketchQuery',
      removeMutationType: 'remove_extrude_profile' },
    { type: 'select', key: 'termination', label: 'Termination', default: 'blind',
      options: [
        { value: 'blind', label: 'Blind' },
        { value: 'up_to', label: 'Up to' },
        { value: 'up_to_next', label: 'Up to next' },
        { value: 'through_all', label: 'Through all' },
      ] },
    { type: 'pick', key: 'up_to', label: 'Up to',
      showWhen: (d) => d.termination === 'up_to',
      transform: stripSelectionWrapper, removeValue: undefined,
      emptyText: '(pick plane, point, or face)' },
    // The offset is the stop surface's own offset: positive past the target's
    // material, negative into it. Shown for both up-to modes; a plain blind
    // extrude reads none.
    { type: 'number', key: 'up_to_offset', label: 'Offset', default: 0, unit: 'mm',
      showWhen: (d) => d.termination === 'up_to' || d.termination === 'up_to_next',
      validate: finite },
    // The user's emboss flow: sketch in front of the surface, up to it, tick
    // this and type the signed amount. It builds only the slab between the
    // surface and its offset.
    { type: 'checkbox', key: 'up_to_start', label: 'Emboss from surface',
      showWhen: (d) => d.termination === 'up_to' || d.termination === 'up_to_next',
      isChecked: (d) => d.up_to_start === 'surface',
      getMutation: (checked) => ({ field: 'up_to_start', value: checked ? 'surface' : null }) },
    { type: 'number', key: 'distance', label: 'Distance', default: DEFAULT_EXTRUDE_DISTANCE,
      // An absent termination is the blind default, so the distance stays for
      // a document that never wrote the key. A through_all cut stores none.
      showWhen: (d) => (d.termination ?? 'blind') === 'blind', validate: positive },
    { type: 'number', key: 'taper', label: 'Taper (deg)', default: 0,
      // A draft is only defined for a one-sided blind sweep: symmetric splits
      // the distance and the other terminations size their own tool. A twist
      // and a taper are refused together, so the field the feature does not use
      // is hidden rather than offered as a losing edit.
      showWhen: (d) => (d.termination ?? 'blind') === 'blind' && d.direction !== 'symmetric' &&
        !angleIsSet(d.twist),
      validate: between(-90, 90) },
    { type: 'number', key: 'twist', label: 'Twist (deg)', default: 0,
      // The TOTAL rotation over the distance, right-handed about the travel
      // direction. Same envelope as a draft; the kernel bounds the angle at the
      // loft's section budget, which a finite check here does not restate.
      showWhen: (d) => (d.termination ?? 'blind') === 'blind' && d.direction !== 'symmetric' &&
        !angleIsSet(d.taper),
      validate: finite },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, names: 'body', removeValue: undefined,
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
    { type: 'number', key: 'angle', label: 'Angle', default: 360, validate: positive },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }, { value: 'symmetric', label: 'Symmetric' }] },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, names: 'body', removeValue: undefined,
      emptyText: '(all bodies)' },
    // An axis pick is required: a revolve has no default axis, so an unpicked
    // one is a solve error rather than a silent sweep about world Z.
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery,
      emptyText: '(pick edge or face, required)' },
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
      removeMutationType: 'remove_sweep_path', transform: stripSelectionWrapper },
    { type: 'pick', key: 'sketch', label: 'Profile', multi: true,
      addMutationType: 'add_sweep_profile', addValueKey: 'sketchQuery',
      removeMutationType: 'remove_sweep_profile', transform: stripSelectionWrapper },
    // Off by default: with it on, each outer loop is a section the path pierces
    // and the body is blended between them, so a same-plane multi-profile sweep
    // keeps its old body until the user opts in.
    { type: 'checkbox', key: 'multisection', label: 'Sections', default: false },
    { type: 'select', key: 'transition', label: 'Corners', default: 'mitre',
      options: [{ value: 'mitre', label: 'Mitre' }, { value: 'round', label: 'Round' }] },
    { type: 'select', key: 'operation', label: 'Operation', default: 'add',
      options: [{ value: 'add', label: 'Add' }, { value: 'cut', label: 'Cut' }, { value: 'new', label: 'New' }] },
    { type: 'pick', key: 'merge_target', label: 'Merge Target',
      showWhen: showMergeTarget, transform: resolveBodyPickRef, names: 'body', removeValue: undefined,
      emptyText: '(all bodies)' },
  ],
}

/** Fillet/chamfer edge gate: the modifier re-finds its edges through the named
 *  `?` query, so a topo-fallback edge (`@body_ex1/edge/3`) is refused at the
 *  chip. A `?` face query is accepted on purpose: the kernel expands it to that
 *  face's edges. The refusal is split by what was picked, so a misclicked plane
 *  or body reads as the wrong kind instead of as an edge with no name. */
const namedEdgePickRefusal = (id: string): string | null => {
  if (id.startsWith('?')) return null
  return /^@[^/]+\/edge\/\d+$/.test(id) ? 'this edge has no named query' : 'pick an edge'
}

export const FILLET_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_fillet',
  subKey: 'fillet',
  defaults: { edges: [], radius: 1 },
  fields: [
    { type: 'pick', key: 'edges', label: 'Edges', multi: true,
      addMutationType: 'add_fillet_edge', addValueKey: 'edgeQuery',
      removeMutationType: 'remove_fillet_edge',
      validatePick: namedEdgePickRefusal },
    { type: 'number', key: 'radius', label: 'Radius', default: 1, validate: positive },
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
      validatePick: namedEdgePickRefusal },
    { type: 'select', key: 'kind', label: 'Kind', default: 'distance',
      options: [{ value: 'distance', label: 'Distance' }, { value: 'angle_distance', label: 'Angle + Distance' }] },
    { type: 'number', key: 'distance', label: 'Distance', default: 1, validate: positive },
    { type: 'number', key: 'angle', label: 'Angle', default: 45,
      showWhen: (d) => d.kind === 'angle_distance', validate: positive },
  ],
}

/** A face pick query: the `?` wire form with a face type restriction, so an
 *  edge query (`:edge`/`:straightedge`) or a vertex is refused, not silently
 *  accepted as a face. */
const FACE_QUERY = /:(flatface|cylinderface|coneface|sphereface|torusface|face)$/
const isFaceQuery = (id: string): boolean => id.startsWith('?') && FACE_QUERY.test(id)

/** A face field's pick rule: null for a named face query, otherwise the reason
 *  the pick is refused. The reasons are split by what the user picked, because
 *  they are shown: a topo-fallback face has no name to persist, a `?` edge or
 *  vertex query is the wrong kind of element, and anything else (a plane, a
 *  whole body, a sketch element) is not a face at all. */
const facePickRefusal = (id: string): string | null => {
  if (!id.startsWith('?')) {
    return /^@[^/]+\/(?:face|tri)\/\d+$/.test(id) ? 'this face has no named query' : 'pick a face'
  }
  return isFaceQuery(id) ? null : 'pick a face, not an edge or vertex'
}

export const DELETE_FACE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_delete_face',
  subKey: 'delete_face',
  defaults: { faces: [] },
  fields: [
    // Any face is accepted at the chip: the kernel refuses what it cannot heal
    // (a non-analytic neighbour, a pick that cannot close the gap) and reports it
    // in failed_faces. Edges, vertices and bodies are refused here by the type
    // restriction, as the shell's face field does.
    { type: 'pick', key: 'faces', label: 'Faces', multi: true,
      addMutationType: 'add_delete_face_ref', addValueKey: 'faceQuery',
      removeMutationType: 'remove_delete_face_ref',
      validatePick: facePickRefusal },
  ],
}

export const SHELL_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_shell',
  subKey: 'shell',
  defaults: { faces: [], thickness: 1, direction: 'inward' },
  fields: [
    { type: 'pick', key: 'faces', label: 'Open Faces', multi: true,
      addMutationType: 'add_shell_face', addValueKey: 'faceQuery',
      removeMutationType: 'remove_shell_face',
      validatePick: facePickRefusal },
    { type: 'number', key: 'thickness', label: 'Thickness', default: 1, validate: positive, unit: 'mm' },
    { type: 'select', key: 'direction', label: 'Direction', default: 'inward',
      options: [{ value: 'inward', label: 'Inward' }, { value: 'outward', label: 'Outward' }] },
    { type: 'select', key: 'join', label: 'Corners', default: 'sharp',
      options: [{ value: 'sharp', label: 'Sharp' }, { value: 'arc', label: 'Round' }] },
    // No face names the body for a closed hollow, so the body pick is the only
    // way to choose it; it is shown only when the opening list is empty.
    { type: 'pick', key: 'source_body', label: 'Body',
      showWhen: (d) => (Array.isArray(d.faces) ? d.faces.length : 0) === 0,
      transform: resolveBodyPickRef, names: 'body', emptyText: '(pick body, required)' },
  ],
}

export const MOVE_FACE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_move_face',
  subKey: 'move_face',
  defaults: { faces: [], distance: 5 },
  fields: [
    { type: 'pick', key: 'faces', label: 'Faces', multi: true,
      addMutationType: 'add_move_face_ref', addValueKey: 'faceQuery',
      removeMutationType: 'remove_move_face_ref',
      // The face's surface kind is a kernel classification, so every analytic
      // kind is accepted at the chip and only a bare `:face` (a B-spline or an
      // unknown surface) is refused, never sampled from triangles. A face the
      // kernel refuses is reported, not dropped. The refusal reason names the
      // rule: the user who picked a freeform face reads which kinds move, not
      // a bogus claim about its query.
      validatePick: (id) => {
        const reason = facePickRefusal(id)
        if (reason !== null) return reason
        return id.endsWith(':face')
          ? 'move face only moves analytic faces (plane, cylinder, cone, sphere, torus)'
          : null
      } },
    // Signed: positive adds material, negative removes, 0 is the identity, so
    // there is no `> 0` validator (the kernel refuses a non-finite value).
    { type: 'number', key: 'distance', label: 'Distance', default: 5, unit: 'mm' },
  ],
}

export const BOOLEAN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_boolean',
  subKey: 'boolean',
  defaults: { operation: 'union', target: '', tools: [] },
  fields: [
    { type: 'select', key: 'operation', label: 'Operation', default: 'union', presentation: 'tabs',
      options: [{ value: 'union', label: 'Union' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }] },
    { type: 'pick', key: 'target', label: 'Target', names: 'body', emptyText: '(pick target)' },
    { type: 'pick', key: 'tools', label: 'Tools', multi: true, names: 'body',
      addMutationType: 'add_boolean_tool', addValueKey: 'tool',
      removeMutationType: 'remove_boolean_tool', removeKey: 'tool', removeValueIsIndex: false },
    { type: 'number', key: 'clearance', label: 'Clearance', default: 0, unit: 'mm',
      showWhen: (d) => d.operation === 'subtract', validate: finite },
    { type: 'checkbox', key: 'keep_tools', label: 'Keep tools', default: false },
  ],
}

// The tapped depth a through hole starts from when "Tap full depth" is
// unchecked: it stores no depth to copy, so any positive value is a start.
const THREAD_DEPTH_FALLBACK = 10

/**
 * The hole sketch pick's own rule: a point is a drill site, a whole-sketch ref
 * drills the points in it, but a picked circle is a profile. Refusing it here
 * keeps the solve from receiving a ref it can only reject, and names the
 * extrude cut that removes the same cylinder (after clearing the flag when the
 * circle is construction). A `?` area pick that narrows to one circle is the
 * same gesture as a curve pick, so it is refused here too.
 */
function holeSketchPickRefusal(selectionId: string, features?: readonly PartFeature[]): string | null {
  if (features === undefined) return null
  const sketchIds = new Set(features.filter((feature) => feature.kind === 'sketch').map((feature) => feature.id))
  const picked = pickedSketchEntity(selectionId, sketchIds)
  if (picked === null) return null
  const sketch = features.find((feature) => feature.id === picked.sketchId)
  const entity = sketch?.kind === 'sketch'
    ? sketch.entities?.find((candidate) => candidate.id === picked.entityId)
    : undefined
  return entity?.kind === 'circle'
    ? circleDrillSiteReason(picked.sketchId, picked.entityId, entity.construction === true)
    : null
}

export const HOLE_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_hole',
  subKey: 'hole',
  defaults: { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal', style: 'simple' },
  fields: [
    { type: 'pick', key: 'sketch', label: 'Sketch', transform: stripSelectionWrapper, validatePick: holeSketchPickRefusal },
    { type: 'number', key: 'diameter', label: 'Diameter', default: 10, validate: positive, unit: 'mm' },
    { type: 'select', key: 'depth_mode', label: 'Depth mode', default: 'blind',
      options: [{ value: 'blind', label: 'Blind' }, { value: 'through_all', label: 'Through All' }] },
    { type: 'number', key: 'depth', label: 'Depth', default: 20,
      showWhen: (d) => d.depth_mode === 'blind', validate: positive, unit: 'mm' },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }] },
    // A widened mouth: the counterbore is a flat-bottomed step, the countersink
    // a cone. Both share `cb_diameter` (the wide mouth diameter); `cb_depth` is
    // the step depth and `cs_angle` the countersink's included angle.
    { type: 'select', key: 'style', label: 'Style', default: 'simple',
      options: [{ value: 'simple', label: 'Simple' }, { value: 'counterbore', label: 'Counterbore' }, { value: 'countersink', label: 'Countersink' }] },
    { type: 'number', key: 'cb_diameter', label: 'Mouth diameter', default: 16,
      showWhen: (d) => d.style != null && d.style !== 'simple', validate: positive, unit: 'mm' },
    { type: 'number', key: 'cb_depth', label: 'Step depth', default: 3,
      showWhen: (d) => d.style === 'counterbore', validate: positive, unit: 'mm' },
    { type: 'number', key: 'cs_angle', label: 'Included angle', default: 90,
      showWhen: (d) => d.style === 'countersink', validate: between(0, 180), unit: 'deg' },
    // A blind hole's bottom: flat, or the cone a twist drill leaves. A through
    // hole has no bottom, so both fields hide there.
    { type: 'select', key: 'tip', label: 'Bottom', default: 'flat',
      showWhen: (d) => d.depth_mode === 'blind',
      options: [{ value: 'flat', label: 'Flat' }, { value: 'drill_point', label: 'Drill point' }] },
    { type: 'number', key: 'tip_angle', label: 'Point angle', default: DRILL_POINT_ANGLE,
      showWhen: (d) => d.depth_mode === 'blind' && d.tip === 'drill_point', validate: between(0, 180), unit: 'deg' },
    // The cosmetic thread: metadata plus a display helix on the bore, no
    // geometry change. The checkbox writes (or clears) the whole spec and the
    // select looks the designation up in the table, so neither writes a field
    // of its own; the diameter stays whatever the user authored (normally the
    // entry's tap drill, which the option label shows).
    { type: 'checkbox', key: '_threaded', label: 'Cosmetic thread', default: false,
      isChecked: (d) => d.thread != null,
      getMutation: (checked, d) => ({
        field: 'thread',
        value: checked ? threadSpecFor(String(d._thread_designation ?? threadDesignations()[0])) : null,
      }) },
    { type: 'select', key: '_thread_designation', label: 'Thread',
      default: threadDesignations()[0],
      showWhen: (d) => d._threaded === true || d.thread != null,
      valueFrom: (d) => String(d.thread?.designation ?? d._thread_designation ?? threadDesignations()[0]),
      getMutation: (option) => ({ field: 'thread', value: threadSpecFor(option) }),
      options: THREAD_TABLE.map((entry) => ({ value: entry.designation, label: threadLabel(entry) })) },
    // The tapped depth (drill 20, tap 15). The number widget has no empty
    // state, so "the whole bore" (no thread_depth stored) is its own checkbox:
    // checking it clears the field, unchecking seeds the blind depth so the
    // user edits down from a value that changes nothing yet.
    { type: 'checkbox', key: '_thread_full', label: 'Tap full depth', default: true,
      showWhen: (d) => d.thread != null,
      isChecked: (d) => d.thread_depth == null,
      getMutation: (checked, d) => ({
        field: 'thread_depth',
        value: checked ? null : threadDepthSeed(d),
      }) },
    { type: 'number', key: 'thread_depth', label: 'Thread depth', default: THREAD_DEPTH_FALLBACK,
      showWhen: (d) => d.thread != null && d.thread_depth != null, validate: positive, unit: 'mm' },
  ],
}

/** The value unchecking "Tap full depth" writes: the blind depth (the same
 *  tapped run the checkbox showed), else the fallback. */
function threadDepthSeed(d: SchemaData): number | string {
  if (d.depth_mode !== 'through_all' && (typeof d.depth === 'number' || typeof d.depth === 'string') && d.depth !== '') {
    return d.depth
  }
  return THREAD_DEPTH_FALLBACK
}

/** The doc's thread spec for a table designation, or the first entry when the
 *  designation is unknown (a hand-edited doc cannot reach here: the loader
 *  would have refused it). */
function threadSpecFor(designation: string): ThreadSpec {
  const entry = threadEntry(designation) ?? THREAD_TABLE[0]
  return { designation: entry.designation, nominal: entry.nominal, pitch: entry.pitch }
}

export const TRANSFORM_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_transform',
  subKey: 'transform',
  defaults: { bodies: [], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
  fields: [
    // Plural, and deliberately without a `transform:` coercion, for the same
    // reason DELETE_BODY_SCHEMA's field has none: `@ex1` here means every body
    // that feature made, split siblings included, and `resolveBodyPickRef`
    // would narrow it to the first sibling.
    { type: 'pick', key: 'bodies', label: 'Bodies', multi: true, names: 'body',
      addMutationType: 'add_transform_body', addValueKey: 'bodyQuery',
      removeMutationType: 'remove_transform_body',
      emptyText: '(pick one or more bodies)' },
    { type: 'select', key: 'operation', label: 'Operation', default: 'new',
      options: [{ value: 'new', label: 'New' }, { value: 'replace', label: 'Replace' }] },
    { type: 'number', key: 'translation', label: 'X', arrayField: 'translation', arrayIndex: 0, default: 0 },
    { type: 'number', key: 'translation', label: 'Y', arrayField: 'translation', arrayIndex: 1, default: 0 },
    { type: 'number', key: 'translation', label: 'Z', arrayField: 'translation', arrayIndex: 2, default: 0 },
    { type: 'number', key: 'rotation_angle', label: 'Angle (deg)', default: 0 },
    { type: 'pick', key: 'rotation_axis', label: 'Axis', transform: stripSelectionWrapper },
    // The Euler triple is a second rotation spelling, shown beside the axis
    // fields: the kernel refuses the pair, and the editor has no control that
    // writes the null clear a mode toggle would need.
    { type: 'number', key: 'rotation_euler', label: 'Euler X (deg)', arrayField: 'rotation_euler', arrayIndex: 0, default: 0 },
    { type: 'number', key: 'rotation_euler', label: 'Euler Y (deg)', arrayField: 'rotation_euler', arrayIndex: 1, default: 0 },
    { type: 'number', key: 'rotation_euler', label: 'Euler Z (deg)', arrayField: 'rotation_euler', arrayIndex: 2, default: 0 },
    { type: 'number', key: 'scale', label: 'Factor', default: 1 },
    { type: 'pick', key: 'scale_center_from', label: 'Origin', transform: stripSelectionWrapper },
  ],
}

export const MIRROR_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_mirror',
  subKey: 'mirror',
  defaults: {
    subject: 'body', body: '', source_features: [], plane: '', keep_original: true, merge: true,
  },
  fields: [
    // The pattern's subject switch, read with absence meaning body (every
    // document written before the feature subject existed is a body mirror).
    { type: 'select', key: 'subject', label: 'Subject', default: 'body', presentation: 'tabs',
      options: [{ value: 'body', label: 'Body' }, { value: 'feature', label: 'Feature' }] },
    { type: 'pick', key: 'body', label: 'Body', names: 'body', showWhen: (d) => d.subject !== 'feature' },
    // The mirrored features are FEATURE rows, not viewport picks; each source's
    // own add or cut is reapplied reflected inside the body it shaped, in
    // feature-log order. The chip's order is presentation only.
    { type: 'pick', key: 'source_features', label: 'Source Features', multi: true,
      addMutationType: 'add_mirror_source', addValueKey: 'sourceFeature',
      removeMutationType: 'remove_mirror_source',
      validatePick: toolSourcePickRefusal,
      showWhen: (d) => d.subject === 'feature',
      emptyText: '(pick one or more features to mirror)',
      hint: 'Reflected in feature-log order; the source keeps its own copy.' },
    { type: 'pick', key: 'target_body', label: 'Target body', transform: resolveBodyPickRef, names: 'body',
      showWhen: (d) => d.subject === 'feature', emptyText: '(the body the source shaped)' },
    { type: 'pick', key: 'plane', label: 'Mirror Plane', transform: stripSelectionWrapper },
    // The source's own operation is reapplied in the same body, so these two
    // whole-body modes have no meaning on a feature mirror (the drive and the
    // kernel refuse them by name). The editor hides them.
    { type: 'checkbox', key: 'keep_original', label: 'Keep Original', default: true,
      showWhen: (d) => d.subject !== 'feature' },
    { type: 'checkbox', key: 'merge', label: 'Merge', default: true,
      showWhen: (d) => d.subject !== 'feature' },
  ],
}

/** A plane pick: a builtin or datum plane id, or a flat-face query. The
 *  surface kind is the kernel classification carried in the query, so a curved
 *  face is refused here rather than sampled from triangles. */
const planePickRefusal = (id: string): string | null => {
  if (id.startsWith('?')) {
    return id.endsWith(':flatface') ? null : 'pick a plane or a flat face, not an edge, vertex or curved face'
  }
  if (id.startsWith('@body_')) return 'pick a plane or a flat face, not a body'
  // A bare @ id is a builtin plane, a datum plane or a feature ref; the kernel
  // names the ones that are not planes, so the chip lets them through.
  if (id.startsWith('@') && !id.includes('/')) return null
  if (id.startsWith('@')) return 'pick a plane or a flat face, not a sketch entity'
  return 'pick a plane or a flat face'
}

export const SPLIT_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_split',
  subKey: 'split',
  defaults: { bodies: [], plane: '', keep: 'above' },
  fields: [
    // Plural, and without a `transform:` coercion for the same reason
    // TRANSFORM_SCHEMA's field has none: `@ex1` here means every body that
    // feature made, split siblings included.
    { type: 'pick', key: 'bodies', label: 'Bodies', multi: true, names: 'body',
      addMutationType: 'add_split_body', addValueKey: 'bodyQuery',
      removeMutationType: 'remove_split_body',
      emptyText: '(pick one or more bodies)' },
    { type: 'pick', key: 'plane', label: 'Split Plane', transform: stripSelectionWrapper,
      validatePick: planePickRefusal },
    { type: 'select', key: 'keep', label: 'Keep', default: 'above',
      options: [
        { value: 'above', label: 'Above (normal side)' },
        { value: 'below', label: 'Below' },
        { value: 'both', label: 'Both' },
      ] },
  ],
}

/** The live instance total under the Skip Instances field. It is computed from
 *  the same pure instance model the kernel uses, so the hint cannot drift from
 *  what the solve builds. */
function patternInstanceHint(d: SchemaData, defaultCount: number): string | null {
  const skip = patternSkipValue(d)
  const centered = d.centered === true
  if (d.second_direction === true) {
    const x = Number(d.count ?? 2)
    const y = Number(d.count_2 ?? 2)
    if (!Number.isInteger(x) || x < 1 || !Number.isInteger(y) || y < 1) return null
    const centeredY = d.centered_2 === true
    if (generatedCount(x, centered) * generatedCount(y, centeredY) > MAX_ARRAY_COUNT) return null
    const generated = toInstances(rectangularIndices(x, y, centered, centeredY))
    const skipped = generated.length - filterSkippedInstances(generated, skip).kept.length
    return instanceSummary(generated, skipped)
  }
  const count = Number(d.count ?? defaultCount)
  if (!Number.isInteger(count) || count < 1 || generatedCount(count, centered) > MAX_ARRAY_COUNT) return null
  const generated = toInstances(instanceIndices(count, centered))
  const skipped = generated.length - filterSkippedInstances(generated, skip).kept.length
  return instanceSummary(generated, skipped)
}

/** The stored skip list, ignoring anything that is not one (a mid-typing
 *  string is the field's own draft, not the document). */
function patternSkipValue(d: SchemaData): SkipEntry[] {
  const skip: unknown = d.skip
  return Array.isArray(skip) ? skip as SkipEntry[] : []
}

/**
 * The pattern and mirror source chip's own rule: a source is a whole feature
 * row, not a viewport pick. Only an earlier extrude, revolve or sweep produces a
 * tool the repeat can reapply (the order and self-reference rule is the pick
 * hook's, shared with every other feature-reference field).
 */
const PATTERN_SOURCE_KINDS = ['extrude', 'revolve', 'sweep'] as const

function toolSourcePickRefusal(id: string, features?: readonly PartFeature[]): string | null {
  if (!id.startsWith('@') || id.includes('/')) {
    return 'pick a feature row (an extrude, revolve or sweep) in the Features list, not viewport geometry'
  }
  if (features === undefined) return null
  const feature = features.find((candidate) => candidate.id === id.slice(1))
  if (feature === undefined) {
    return 'pick a feature row (an extrude, revolve or sweep) in the Features list'
  }
  return (PATTERN_SOURCE_KINDS as readonly string[]).includes(feature.kind)
    ? null
    : 'a pattern or mirror source is an extrude, revolve or sweep'
}

// Both pattern kinds repeat the same thing: one feature, two subjects, one
// source list. The rows are one array so the two schemas cannot drift; each
// kind appends only its own instance grid.
export const PATTERN_SOURCE_FIELDS: EditorFieldDef[] = [
  // A body pattern copies a whole body; a feature pattern reapplies earlier
  // solid producers' own add or cut.
  { type: 'select', key: 'subject', label: 'Subject', default: 'body', presentation: 'tabs',
    options: [{ value: 'body', label: 'Body' }, { value: 'feature', label: 'Feature' }] },
  { type: 'pick', key: 'source_body', label: 'Body', transform: resolveBodyPickRef, names: 'body',
    showWhen: (d) => d.subject !== 'feature', emptyText: '(pick the body to copy)' },
  // The sources are FEATURE rows, not viewport picks: the chip shows the picked
  // extrude/revolve/sweep rows and the feature tree is the pick surface. Every
  // source is reapplied at each grid instance, in the order the sources sit in
  // the feature log; the earliest source's first produced body is the instance-0
  // seed (the count includes it and the grid leaves it in place). The chip's own
  // order is presentation only, because the kernel sorts by the log.
  { type: 'pick', key: 'source_features', label: 'Source Features', multi: true,
    addMutationType: 'add_pattern_source', addValueKey: 'sourceFeature',
    removeMutationType: 'remove_pattern_source',
    validatePick: toolSourcePickRefusal,
    showWhen: (d) => d.subject === 'feature',
    emptyText: '(pick one or more features; the earliest heads the seed)',
    hint: 'Repeated in feature-log order; the earliest source heads the seed slot.' },
  { type: 'pick', key: 'target_body', label: 'Target body', transform: resolveBodyPickRef, names: 'body',
    showWhen: (d) => d.subject === 'feature', emptyText: '(the body the source shaped)' },
  { type: 'select', key: 'operation', label: 'Operation', default: 'add',
    showWhen: (d) => d.subject !== 'feature',
    options: [{ value: 'add', label: 'Add' }, { value: 'new', label: 'New' }] },
]

/** Show a legacy feature pattern with its inferred subject and the singular
 *  source as the one-element list it means, without rewriting the document. */
function normalizePatternSource(raw: SchemaData): SchemaData {
  const data: SchemaData = { ...raw, subject: patternSubject(raw) }
  if (!Array.isArray(data.source_features)) {
    const legacy = data.source_feature
    data.source_features = typeof legacy === 'string' && legacy !== '' ? [legacy] : []
  }
  return data
}

const patternSkipField = (defaultCount: number): TextFieldDef => ({
  // The page-selector text: signed indices only, `i:j` for a grid cell.
  type: 'text', key: 'skip', label: 'Skip Instances', default: '',
  placeholder: 'e.g. 2, 5 or 2:-1',
  title: SKIP_LIST_TITLE,
  format: (v) => formatSkipList(Array.isArray(v) ? v as SkipEntry[] : []),
  parse: (text) => { const parsed = parseSkipList(text); return parsed.ok ? parsed.skip : null },
  parseReason: (text) => { const parsed = parseSkipList(text); return parsed.ok ? null : parsed.error },
  hint: (d) => patternInstanceHint(d, defaultCount),
})

/** A directive-length pick needs a length of its own. A body pick carries its
 *  kind as the query's type restriction (`:straightedge`, `:cylinderface`, ...),
 *  so a face without one, or a curved edge, is refused here with the reason; a
 *  sketch entity pick carries no restriction and is left to the kernel, which
 *  resolves the line's length and refuses a circle by name. */
const LENGTH_PICK = /:(straightedge|cylinderface|coneface)$/

export function directiveLengthPickProblem(selectionId: string): string | null {
  const reason = 'directive length needs a pick with a length (a straight edge, cylinder or cone)'
  if (LENGTH_PICK.test(selectionId)) return null
  if (selectionId.startsWith('entity:')) return null
  const kind = /:([a-z]+)$/.exec(selectionId)?.[1]
  const noun = kind === 'flatface' ? 'a planar face'
    : kind === 'edge' || kind === 'circle' || kind === 'arc' ? 'a circle'
      : 'that pick'
  return `${reason}; ${noun} has none`
}

const linearDirectionPick = (modeKey: string) =>
  (selectionId: string, _features?: readonly PartFeature[], data?: SchemaData): string | null =>
    data?.[modeKey] === 'directive_length' ? directiveLengthPickProblem(selectionId) : null

/** The resolved spacing a directive-length direction produced, for its read-only
 *  row; null until a solve has reported one. */
const spacingRow = (label: string, key: string, resultKey: string): ReadonlyFieldDef => ({
  type: 'readonly', key, label, unit: 'mm',
  value: (solved) => {
    const pitch = solvedNumber(solved, resultKey)
    return pitch === null ? null : String(Math.round(pitch * 1e6) / 1e6)
  },
})

const MANUAL_ROWS = (prefix: string, modeKey: string, field: string): EditorFieldDef[] => [
  { type: 'number', key: field, label: `${prefix}X`, arrayField: field, arrayIndex: 0, default: 0,
    showWhen: (d) => d[modeKey] === 'manual' },
  { type: 'number', key: field, label: `${prefix}Y`, arrayField: field, arrayIndex: 1, default: 0,
    showWhen: (d) => d[modeKey] === 'manual' },
  { type: 'number', key: field, label: `${prefix}Z`, arrayField: field, arrayIndex: 2, default: 0,
    showWhen: (d) => d[modeKey] === 'manual' },
]

export const LINEAR_PATTERN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_linear_pattern',
  subKey: 'linear_pattern',
  defaults: { subject: 'body', operation: 'add', count: 2, pitch: 20, source_features: [] },
  normalize: normalizePatternSource,
  fields: [
    ...PATTERN_SOURCE_FIELDS,
    // How this direction gets its step. The mode keeps the other modes' fields
    // in the document, so switching back restores what was typed; only the
    // active mode's rows show.
    { type: 'select', key: 'direction_mode', label: 'Direction type', default: 'direction_distance',
      options: LINEAR_DIRECTION_MODES.map((mode) => ({ value: mode, label: LINEAR_DIRECTION_MODE_LABELS[mode] })) },
    { type: 'pick', key: 'direction_query', label: 'Direction', transform: resolveAxisQuery,
      showWhen: (d) => d.direction_mode !== 'manual',
      validatePick: linearDirectionPick('direction_mode'),
      emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert', label: 'Invert', default: false },
    // Count is the total on direction 1 and includes the source's own slot: 2
    // makes one copy. Count 1 keeps only the original and is a quiet no-op, so
    // the floor is 1. The schema leaves the floor to validateWith so the shared
    // rule's sentence is what the user sees.
    { type: 'number', key: 'count', label: 'Count', default: 2, parse: 'int',
      max: MAX_ARRAY_COUNT, validateWith: (v) => arrayCountProblem('count', v) },
    // Direction + Distance reads a pitch; Directive length reads the pick's own
    // length instead, shown from the last solve; Manual reads the vector below.
    { type: 'number', key: 'pitch', label: 'Pitch', default: 20, validate: nonNegative, min: 0,
      showWhen: (d) => d.direction_mode !== 'directive_length' && d.direction_mode !== 'manual' },
    { ...spacingRow('Spacing', 'resolved_pitch', 'resolved_pitch'),
      showWhen: (d) => d.direction_mode === 'directive_length' },
    { type: 'number', key: 'direction', label: 'Step X', arrayField: 'direction', arrayIndex: 0, default: 0,
      showWhen: (d) => d.direction_mode === 'manual' },
    { type: 'number', key: 'direction', label: 'Step Y', arrayField: 'direction', arrayIndex: 1, default: 0,
      showWhen: (d) => d.direction_mode === 'manual' },
    { type: 'number', key: 'direction', label: 'Step Z', arrayField: 'direction', arrayIndex: 2, default: 0,
      showWhen: (d) => d.direction_mode === 'manual' },
    // Centered also generates the reverse side (-1, -2, ...), so count 2 is
    // three instances: the original plus one copy either side.
    { type: 'checkbox', key: 'centered', label: 'Centered', default: false },
    // The retired rectangular mode: direction 2 is the row, direction 1 the
    // column, and the seed cell (0, 0) stays the source.
    { type: 'checkbox', key: 'second_direction', label: 'Second direction', default: false },
    { type: 'select', key: 'direction_2_mode', label: 'Direction 2 type', default: 'direction_distance',
      showWhen: (d) => d.second_direction === true,
      options: LINEAR_DIRECTION_MODES.map((mode) => ({ value: mode, label: LINEAR_DIRECTION_MODE_LABELS[mode] })) },
    { type: 'pick', key: 'direction_2_query', label: 'Direction 2', transform: resolveAxisQuery,
      showWhen: (d) => d.second_direction === true && d.direction_2_mode !== 'manual',
      validatePick: linearDirectionPick('direction_2_mode'),
      emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert_2', label: 'Invert 2', default: false,
      showWhen: (d) => d.second_direction === true },
    { type: 'number', key: 'count_2', label: 'Count 2', default: 2,
      showWhen: (d) => d.second_direction === true, parse: 'int', max: MAX_ARRAY_COUNT,
      validateWith: (v, d) => arrayCountProblem('count_2', v, d.count) },
    { type: 'number', key: 'pitch_2', label: 'Pitch 2', default: 20,
      showWhen: (d) => d.second_direction === true
        && d.direction_2_mode !== 'directive_length' && d.direction_2_mode !== 'manual',
      validate: nonNegative, min: 0 },
    { ...spacingRow('Spacing 2', 'resolved_pitch_2', 'resolved_pitch_2'),
      showWhen: (d) => d.second_direction === true && d.direction_2_mode === 'directive_length' },
    ...MANUAL_ROWS('Step 2 ', 'direction_2_mode', 'direction_2').map((f) => ({
      ...f, showWhen: (d: SchemaData) => d.second_direction === true && d.direction_2_mode === 'manual',
    })),
    { type: 'checkbox', key: 'centered_2', label: 'Centered 2', default: false,
      showWhen: (d) => d.second_direction === true },
    patternSkipField(2),
  ],
}

export const CIRCULAR_PATTERN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_circular_pattern',
  subKey: 'circular_pattern',
  defaults: { subject: 'body', operation: 'add', count: 4, angle: 360, equal_spacing: true, source_features: [] },
  normalize: normalizePatternSource,
  fields: [
    ...PATTERN_SOURCE_FIELDS,
    // An axis pick is required; `invert_axis` reverses the sweep.
    { type: 'pick', key: 'axis', label: 'Axis', transform: resolveAxisQuery,
      emptyText: '(pick edge or face, required)' },
    { type: 'checkbox', key: 'invert_axis', label: 'Invert axis', default: false },
    { type: 'number', key: 'count', label: 'Count', default: 4, parse: 'int',
      max: MAX_ARRAY_COUNT, validateWith: (v) => arrayCountProblem('count', v) },
    // Equal spacing (the default) reads the angle as the full sweep: a full turn
    // spreads over 360 / total, a smaller sweep puts the ends ON the sweep ends.
    // Off, the angle is the increment between neighbours.
    { type: 'number', key: 'angle', label: 'Angle', default: 360, unit: 'deg',
      validate: (v) => v > 0 ? null : 'must be a positive number of degrees; reverse the sense with Invert axis' },
    { type: 'checkbox', key: 'equal_spacing', label: 'Equal spacing', default: true },
    { type: 'checkbox', key: 'centered', label: 'Centered', default: false },
    patternSkipField(4),
  ],
}

/** A curve pattern names a plane, flat face or straight edge as the direction
 *  its copies turn about. The kernel owns the exact resolution (a curved face
 *  and a body are named there), so the chip only refuses what is certainly not
 *  a direction. */
const normalRefPickRefusal = (id: string): string | null => {
  if (id.startsWith('?')) return null
  if (id.startsWith('@')) return null
  return 'pick a plane, a flat face or a straight edge'
}

/** The live instance total plus the spacing law this kind is using. The path's
 *  own length is a solve-time fact the editor does not hold, so the hint states
 *  which law applies rather than a spacing number it would have to invent. */
function curvePatternInstanceHint(d: SchemaData): string | null {
  const summary = patternInstanceHint(d, 3)
  if (summary === null) return null
  if (d.spacing === 'distance') {
    const distance = Number(d.distance ?? 20)
    return Number.isFinite(distance)
      ? `${summary}; ${distance} apart along the path`
      : `${summary}; enter the distance between neighbours`
  }
  return `${summary}; equal spacing splits the path length`
}

export const CURVE_PATTERN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_curve_pattern',
  subKey: 'curve_pattern',
  defaults: { subject: 'body', operation: 'add', count: 3, spacing: 'equal', orientation: 'tangent', path: [], source_features: [] },
  normalize: (raw) => ({ ...normalizePatternSource(raw), path: normalizeRefList(raw.path) }),
  fields: [
    ...PATTERN_SOURCE_FIELDS,
    // The path is the sweep's path grammar, picked one curve at a time.
    { type: 'pick', key: 'path', label: 'Path', multi: true,
      addMutationType: 'add_curve_pattern_path', addValueKey: 'pathQuery',
      removeMutationType: 'remove_curve_pattern_path', transform: stripSelectionWrapper,
      emptyText: '(pick a path curve, required)' },
    { type: 'checkbox', key: 'reverse', label: 'Reverse', default: false },
    { type: 'number', key: 'count', label: 'Count', default: 3, parse: 'int',
      max: MAX_ARRAY_COUNT, validateWith: (v) => arrayCountProblem('count', v) },
    // Equal spacing splits the path length: the last instance lands on an open
    // path's end, while a closed path splits by the count. Distance is the arc
    // length between neighbours instead.
    { type: 'select', key: 'spacing', label: 'Spacing', default: 'equal',
      options: [{ value: 'equal', label: 'Equal spacing' }, { value: 'distance', label: 'Distance' }] },
    { type: 'number', key: 'distance', label: 'Distance', default: 20, unit: 'mm',
      showWhen: (d) => d.spacing === 'distance', validate: positive, min: 0 },
    // How a copy turns: with the path (a rotation-minimizing frame, so a path
    // whose curvature changes sign does not flip the copies), only about a
    // picked normal, or not at all.
    { type: 'select', key: 'orientation', label: 'Orientation', default: 'tangent',
      options: [
        { value: 'tangent', label: 'Tangential to curve' },
        { value: 'normal_to', label: 'Normal to' },
        { value: 'fixed', label: 'Fixed' },
      ] },
    { type: 'pick', key: 'normal_ref', label: 'Normal to', transform: stripSelectionWrapper,
      showWhen: (d) => d.orientation === 'normal_to', validatePick: normalRefPickRefusal,
      emptyText: '(pick a plane, flat face or straight edge)' },
    // No Centered row: a path has a start, not a middle.
    { ...patternSkipField(3), hint: curvePatternInstanceHint },
  ],
}

/** The sketch form names the sketch itself, not one of its entities: the whole
 *  sketch's non-construction points are the targets. */
function instanceSketchPickRefusal(id: string, features?: readonly PartFeature[]): string | null {
  if (id.startsWith('entity:') || id.startsWith('vertex:') || id.startsWith('?')) {
    return 'pick the sketch itself, not one of its entities; the sketch form copies onto every point'
  }
  if (!id.startsWith('@') || id.includes('/')) return 'pick a sketch feature row'
  if (features === undefined) return null
  const feature = features.find((candidate) => candidate.id === id.slice(1))
  return feature !== undefined && feature.kind === 'sketch' ? null : 'pick a sketch feature row'
}

/** A no-normal pick is a body vertex or a straight body edge. The pick's own
 *  kind rides in the query's type restriction, so the hint can mark it before
 *  the kernel resolves anything. */
function noNormalPick(ref: string): boolean {
  return /:vertex\b|:straightedge\b/.test(ref)
}

/** The numbered target list plus the source-normal rule this form will use. The
 *  sketch form reads its points from the document's own sketch row; a bare add
 *  has neither form configured yet and says so. */
function instancePatternHint(d: SchemaData, context: HintContext): string | null {
  const labels: string[] = []
  let form = 'none'
  if (typeof d.sketch === 'string' && d.sketch !== '') {
    form = 'sketch'
    const sketchId = d.sketch.replace(/^@/, '').split('/')[0]
    const sketch = context.features?.find((candidate) => candidate.id === sketchId && candidate.kind === 'sketch')
    if (sketch !== undefined && sketch.kind === 'sketch') {
      for (const entity of sketch.entities ?? []) {
        if (entity.kind === 'point' && entity.construction !== true) labels.push(entity.id)
      }
    }
  } else if (Array.isArray(d.targets) && d.targets.length > 0) {
    form = 'targets'
    for (const ref of d.targets as string[]) {
      labels.push(noNormalPick(ref) ? `${ref} (no normal, moved only)` : ref)
    }
  }
  if (form === 'none') return 'pick a sketch or a target list; the source goes on every point or pick'
  const shown = labels.slice(0, 12).map((label, i) => `${i + 1} = ${label}`)
  const more = labels.length > shown.length ? `, ... ${labels.length - shown.length} more` : ''
  const skipped = Array.isArray(d.skip) ? d.skip.length : 0
  const total = labels.length
  const parts = [`${shown.join(', ')}${more}`, `${total} target${total === 1 ? '' : 's'}`]
  const fresh = Math.max(0, total - 1 - skipped)
  parts.push(`${fresh} new`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (d.orientation === 'fixed') parts.push('copies are translated only')
  else parts.push('each copy turns onto its target\'s normal')
  const reference = typeof d.reference === 'string' && d.reference !== ''
    ? 'the reference pick'
    : form === 'sketch' ? 'the sketch plane' : 'the first target with a normal'
  parts.push(`source normal: ${reference}`)
  return parts.join('; ')
}

export const INSTANCE_PATTERN_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_instance_pattern',
  subKey: 'instance_pattern',
  defaults: { subject: 'body', operation: 'add', orientation: 'normal', targets: [], source_features: [] },
  normalize: normalizePatternSource,
  fields: [
    ...PATTERN_SOURCE_FIELDS,
    // One target form at a time. The select's mutation clears the other form,
    // because a stored pair would be refused by the kernel.
    { type: 'select', key: 'targets', label: 'Targets', default: 'sketch',
      valueFrom: (d) => typeof d.sketch === 'string' && d.sketch !== ''
        ? 'sketch'
        : Array.isArray(d.targets) && d.targets.length > 0 ? 'picked' : 'sketch',
      options: [{ value: 'sketch', label: 'Sketch points' }, { value: 'picked', label: 'Picked' }],
      getMutation: (option) => option === 'sketch'
        ? { field: 'targets', value: [] }
        : { field: 'sketch', value: '' } },
    { type: 'pick', key: 'sketch', label: 'Sketch', transform: stripSelectionWrapper,
      validatePick: instanceSketchPickRefusal,
      showWhen: (d) => !Array.isArray(d.targets) || d.targets.length === 0,
      emptyText: '(pick a sketch; every non-construction point is a target)' },
    { type: 'pick', key: 'targets', label: 'Targets', multi: true,
      addMutationType: 'add_instance_pattern_target', addValueKey: 'targetQuery',
      removeMutationType: 'remove_instance_pattern_target', transform: stripSelectionWrapper,
      showWhen: (d) => !(typeof d.sketch === 'string' && d.sketch !== ''),
      emptyText: '(pick any face, edge, vertex, sketch point or plane)' },
    { type: 'pick', key: 'reference', label: 'Reference', transform: stripSelectionWrapper,
      emptyText: '(automatic: sketch point or centroid)' },
    { type: 'select', key: 'orientation', label: 'Orientation', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'fixed', label: 'Fixed' }] },
    { type: 'checkbox', key: 'reverse_normal', label: 'Reverse normal', default: false,
      showWhen: (d) => d.orientation !== 'fixed' },
    { ...patternSkipField(2), hint: instancePatternHint },
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
    { type: 'pick', key: 'bodies', label: 'Bodies', multi: true, names: 'body',
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

// A helix rides a cylinder face, a circular edge or a sketch circle/line. The
// type restriction rides in the selection id (`...:cylinderface`, `:arc`, ...),
// so a flat/cone face and an ellipse are refused at pick time by omission; the
// solver repeats the check because a hand-written doc skips this gate.
function helixPickRefusal(id: string): string | null {
  // Refuse the face/edge kinds a helix cannot sit on by name. The type
  // restriction rides in the ancestry query (`...:coneface`).
  const refusal = 'a helix sits on a cylinder face, a circular edge or a circle'
  for (const bad of ['flatface', 'coneface', 'sphereface', 'torusface', 'ellipse']) {
    if (id.includes(':' + bad)) return refusal
  }
  // Everything else a pick can name is a candidate: an ancestry query
  // (?...:cylinderface/:circle/:arc/:straightedge), a sketch entity
  // (@sketch/entity), a topo-fallback face (@body/face/N) or an entity ref.
  // A body or wrong-kind face that slips through is refused by the solver.
  if (id.startsWith('?') || id.startsWith('@') || id.startsWith('entity:')) return null
  return refusal
}

const HELIX_USES_PITCH = (d: SchemaData) => d.mode === 'pitch_turns' || d.mode === 'pitch_height'
const HELIX_USES_TURNS = (d: SchemaData) =>
  d.mode === 'pitch_turns' || d.mode === 'turns_height' || d.mode === 'angle_turns'
const HELIX_USES_HEIGHT = (d: SchemaData) =>
  d.mode === 'pitch_height' || d.mode === 'turns_height' || d.mode === 'angle_height'
const HELIX_USES_ANGLE = (d: SchemaData) => d.mode === 'angle_turns' || d.mode === 'angle_height'
const HELIX_FACE_REF = (d: SchemaData) => typeof d.reference === 'string' && d.reference.includes(':cylinderface')

export const HELIX_SCHEMA: FeatureEditorSchema = {
  mutationPrefix: 'set_helix',
  subKey: 'helix',
  defaults: {
    reference: '', radius_mode: 'derived', mode: 'pitch_turns',
    pitch: 1, turns: 5, height: 5, helix_angle: 5, offset: 0, start_angle: 0,
    hand: 'right', direction: 'normal',
  },
  fields: [
    { type: 'pick', key: 'reference', label: 'Reference',
      validatePick: helixPickRefusal, emptyText: '(pick a cylinder face, edge or circle)' },
    { type: 'select', key: 'radius_mode', label: 'Radius', default: 'derived',
      options: [{ value: 'derived', label: 'From reference' }, { value: 'entered', label: 'Enter' }] },
    { type: 'number', key: 'radius', label: 'Radius', default: 5,
      showWhen: (d) => d.radius_mode === 'entered', validate: positive, unit: 'mm' },
    { type: 'select', key: 'mode', label: 'Define by', default: 'pitch_turns',
      options: [
        { value: 'pitch_turns', label: 'Pitch + Turns' },
        { value: 'pitch_height', label: 'Pitch + Height' },
        { value: 'turns_height', label: 'Turns + Height' },
        { value: 'angle_turns', label: 'Angle + Turns' },
        { value: 'angle_height', label: 'Angle + Height' },
      ] },
    { type: 'number', key: 'pitch', label: 'Pitch', default: 1, showWhen: HELIX_USES_PITCH, validate: positive, unit: 'mm' },
    { type: 'number', key: 'turns', label: 'Turns', default: 5, showWhen: HELIX_USES_TURNS, validate: positive },
    { type: 'number', key: 'height', label: 'Height', default: 5, showWhen: HELIX_USES_HEIGHT, validate: positive, unit: 'mm' },
    { type: 'number', key: 'helix_angle', label: 'Helix angle', default: 5,
      showWhen: HELIX_USES_ANGLE, validate: between(0, 90), unit: 'deg' },
    { type: 'checkbox', key: 'height_from_reference', label: 'Height from reference', default: false,
      showWhen: (d) => HELIX_USES_HEIGHT(d) && HELIX_FACE_REF(d) },
    { type: 'number', key: 'start_angle', label: 'Start angle', default: 0, unit: 'deg' },
    { type: 'number', key: 'offset', label: 'Offset', default: 0, unit: 'mm' },
    { type: 'select', key: 'hand', label: 'Hand', default: 'right',
      options: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }] },
    { type: 'select', key: 'direction', label: 'Direction', default: 'normal',
      options: [{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }] },
  ],
}

export const EDITOR_SCHEMAS: Record<string, FeatureEditorSchema> = {
  extrude: EXTRUDE_SCHEMA,
  revolve: REVOLVE_SCHEMA,
  sweep: SWEEP_SCHEMA,
  fillet: FILLET_SCHEMA,
  chamfer: CHAMFER_SCHEMA,
  shell: SHELL_SCHEMA,
  move_face: MOVE_FACE_SCHEMA,
  delete_face: DELETE_FACE_SCHEMA,
  boolean: BOOLEAN_SCHEMA,
  hole: HOLE_SCHEMA,
  transform: TRANSFORM_SCHEMA,
  mirror: MIRROR_SCHEMA,
  split: SPLIT_SCHEMA,
  linear_pattern: LINEAR_PATTERN_SCHEMA,
  circular_pattern: CIRCULAR_PATTERN_SCHEMA,
  curve_pattern: CURVE_PATTERN_SCHEMA,
  instance_pattern: INSTANCE_PATTERN_SCHEMA,
  delete_body: DELETE_BODY_SCHEMA,
  variable: VARIABLE_SCHEMA,
  helix: HELIX_SCHEMA,
}
