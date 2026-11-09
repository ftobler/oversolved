// The one description of the mutation vocabulary: what each type means, which
// fields it carries and which of those an external script may send. The union
// in types/cad.ts is the compile-time truth; this table is its runtime twin,
// and the mapped type below makes a missing row fail `tsc -b`. Adding a field
// to a union member without adding it here is caught by
// drive/mutationCatalogTypecheck.ts.
//
// The table also guards the drive boundary: an untyped JSON step is validated
// here before it is cast to Mutation, so a typo or a missing field is a named
// step failure instead of a silent no-op. Presence, JSON type and the value a
// field may hold are checked; the appliers still own the geometry meaning.

import type { FeatureKind, Mutation, PartDoc } from '@/types/cad'
import {
  featureFieldNames,
  featureParamsSchema,
  planeDefinitionSchema,
  type JsonSchema,
} from '@/persistence/partDocSchema'
import { entityParamLayoutsSentence } from '@/registry/entityRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { mutationValueViolation, EMPTY_REF_CLEARS } from '@/drive/mutationValues'
import { MAX_REPORTED_CREATED_IDS } from '@/drive/scriptRunner'
import { MAX_PATTERN_INSTANCES, MAX_SKETCH_ENTITIES } from '@/utils/geometry/sketchPattern'
import { MAX_TEXT_ENTITIES } from '@/utils/geometry/textExpand'

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'point'
  | 'array'
  | 'object'
  | 'query'
  // A query string, or a `{selector}` authoring aid the headless drive resolves
  // into the query string before the mutation applies.
  | 'queryOrSelector'
  // A field whose applier accepts a string or a number (a definition value).
  | 'scalar'
  // A pass-through value whose shape belongs to the applier (set_*_field).
  | 'any'

export interface FieldInfo {
  type: FieldType
  required: boolean
  note?: string
  // The JSON shape of an object field, read from the part-document schema so
  // the catalog and the published contract cannot drift.
  shape?: JsonSchema
  // True only where the union spells `| null`; null is a value, not a missing
  // field, so an optional field is not implicitly nullable.
  nullable?: boolean
  // Internal plumbing a script must not send; omitted from the listing.
  internal?: true
}

export interface MutationInfo {
  summary: string
  fields: Record<string, FieldInfo>
  // Row-level guidance the field notes cannot place, such as what a feature's
  // sketch ref must name.
  note?: string
  // Internal plumbing an external script must not send.
  hidden?: true
}

export type MutationFamily = 'sketch' | 'features' | 'picks' | 'part style' | 'document'

// The helpers keep `type`, `required` and `nullable` as literal types so the
// type-level check in mutationCatalogTypecheck.ts can compare a union member's
// optional and nullable keys against its catalog row.
const str = (note?: string) => ({ type: 'string', required: true, ...(note !== undefined && { note }) } as const)
const optStr = (note?: string) => ({ type: 'string', required: false, ...(note !== undefined && { note }) } as const)
const optNullableStr = (note?: string) =>
  ({ type: 'string', required: false, nullable: true, ...(note !== undefined && { note }) } as const)
const nullableStr = () => ({ type: 'string', required: false, nullable: true } as const)
const num = (note?: string) => ({ type: 'number', required: true, ...(note !== undefined && { note }) } as const)
const optNum = () => ({ type: 'number', required: false } as const)
const optObj = () => ({ type: 'object', required: false } as const)
const bool = () => ({ type: 'boolean', required: true } as const)
const optBool = (note?: string) => ({ type: 'boolean', required: false, ...(note !== undefined && { note }) } as const)
const point = (note?: string) => ({ type: 'point', required: true, ...(note !== undefined && { note }) } as const)
const optPoint = (note?: string) => ({ type: 'point', required: false, ...(note !== undefined && { note }) } as const)
const arr = (note?: string) => ({ type: 'array', required: true, ...(note !== undefined && { note }) } as const)
const optArr = (note?: string) => ({ type: 'array', required: false, ...(note !== undefined && { note }) } as const)
const obj = (note?: string) => ({ type: 'object', required: true, ...(note !== undefined && { note }) } as const)
const shapedObj = (shape: JsonSchema, note?: string) =>
  ({ type: 'object', required: false, shape, ...(note !== undefined && { note }) } as const)
const query = (note: string) => ({ type: 'query', required: true, note } as const)
// A pick an author may name with `select`'s grammar instead of pasting the
// query string it returned; the drive resolves the selector, the document
// stores only the query.
const optQueryOrSelector = (note: string) =>
  ({ type: 'queryOrSelector', required: false, note } as const)
const queryOrSelector = (note: string) =>
  ({ type: 'queryOrSelector', required: true, note } as const)
// The pass-through setter value: null is the documented clear (a deleted
// field), so it is nullable even though the applier owns the real type.
const anyValue = (note?: string) =>
  ({ type: 'any', required: true, nullable: true, ...(note !== undefined && { note }) } as const)
// A number-or-expression field a bulk add can carry in its own payload.
const optScalar = (note?: string) =>
  ({ type: 'scalar', required: false, ...(note !== undefined && { note }) } as const)
// The circular array's step_angle is the one inline field the union spells
// `| null`; null is the documented clear, so the add row must admit it too.
const optNullableScalar = (note?: string) =>
  ({ type: 'scalar', required: false, nullable: true, ...(note !== undefined && { note }) } as const)

// The insert slot and the drag snapshot are journal/gesture plumbing: both ride
// on a payload the app produces, never on one a script authors.
const insertAt = () => ({ type: 'number', required: false, internal: true } as const)
const solvedGeometry = () =>
  ({
    type: 'object',
    required: false,
    internal: true,
    note: 'Solved geometry snapshot keyed by entity id; internal solve write-back plumbing with no part-document schema definition.',
  } as const)

// A feature add's shared optional label plus its insertion slot.
const featureAddFields = () => ({
  featureId: str('The feature id the new row gets.'),
  label: optStr(),
  insertAt: insertAt(),
})

// The fill rule a whole-sketch profile gets, so a drawing that means a notch
// does not silently become a bump (Ex007: an R0.25 hole circle moved past the
// R2 rim added material instead of cutting, status ok, no warning). The kernel
// cannot tell a deliberate overlap from a mistake, so the rule is stated where
// the profile field is read.
const PROFILE_LOOPS_NOTE =
  'A whole-sketch profile fills even/odd: a loop nested inside another is a hole, loops that cross each '
  + 'other are filled as their union, so a circle meant as a hole that pokes past the rim of another loop '
  + 'adds a bump there instead of cutting, with no warning; keep a cut loop inside its boundary.'

// The ref grammar the drive boundary accepts (mutationValues profileRefProblem)
// and the leaves resolve. It is the same sentence on every profile and path
// field, so a pick that works on one add is not refused on another; the sweep's
// one-ref-per-curve rule is stated because a slot needs four refs, not one.
const PROFILE_REF_NOTE =
  'A profile or path ref is a whole sketch as `$<sketchId>` or `@<sketchId>`, one curve as ' +
  '`entity:<sketchId>:<entityId>`, or a `?` area query from `select`; a sweep takes one ref per curve ' +
  '(four for a slotted loop, one `add_sweep_profile` per curve) and one path ref per curve, while extrude ' +
  'and revolve take one closed curve per ref. `vertex:<sketchId>:<entityId>:<vertexKey>` names the same ' +
  'entity as `entity:`, and `@<sketchId>/<entityId>` or `@<bodyId>/face/<n>` is a face-profile pick ' +
  '(a sweep refuses a face pick).'

// The sweep profile field is read by two forms with their own rules, so the
// extrude fill note above would be false here: a multisection classifies loops
// by containment only and never unions crossing loops.
const SWEEP_SKETCH_NOTE =
  'A multisection sweep takes each outer loop a section sketch draws as one section; a loop nested ' +
  'inside another is a hole and is refused; loops that cross each other are NOT unioned here, so draw ' +
  'one closed outer loop per section. A single-profile sweep carries the profile from the path start ' +
  'as drawn, so a profile beside the path, or off its plane, keeps its offset in the moving frame; it ' +
  'must lie within its own size of a path crossing, or of the path start when the path never crosses ' +
  'its plane, and the path start must leave the plane at 5 degrees or more. A profile lying along the ' +
  'path is refused, not built.'

const sketchQuery = () => query('A profile ref. ' + PROFILE_REF_NOTE + ' ' + PROFILE_LOOPS_NOTE)
const sweepSketchQuery = () => query('A profile ref. ' + PROFILE_REF_NOTE + ' ' + SWEEP_SKETCH_NOTE)
// A helix is a sweep path through its own arm in solveSweep, not the sketch
// topology route, so the profile-ref grammar above never mentions it; a thread
// author reading only the catalogue would otherwise never try it.
// docs/drive.md quotes the sentence verbatim (fitSplineDocs.test.ts).
export const SWEEP_HELIX_PATH_NOTE =
  'A bare `$<helixId>` (or `@<helixId>`) names a helix as the path, the way to sweep a thread; it ' +
  'must stand alone as the only path ref and is refused with `multisection`.'
const pathQuery = () =>
  query('A path ref. ' + PROFILE_REF_NOTE + ' ' + SWEEP_HELIX_PATH_NOTE + ' See docs/document.md, helix.')

// The authoring recipe a practice run could not find: the tangent vector's
// length already is the per-end magnitude, so no separate scalar field exists.
// docs/drive.md quotes this sentence verbatim (fitSplineDocs.test.ts).
export const FIT_SPLINE_TANGENT_MAGNITUDE_NOTE =
  'Each tangent is an end derivative vector, so its length is that end\'s magnitude: `tangentScale: false` ' +
  'keeps the authored length, while the default `true` replaces it with OCCT\'s `ScaleTangents` value and ' +
  'keeps only the direction. A per-end tangent scalar is the unit direction times that scalar, with ' +
  '`tangentScale: false`.'
const FIT_SPLINE_TANGENTS_NOTE =
  'fit_spline only: [start, end] end tangents, each [tx, ty] or null. ' + FIT_SPLINE_TANGENT_MAGNITUDE_NOTE
const FIT_SPLINE_TANGENT_SCALE_NOTE =
  'fit_spline only: true (default) rescales each authored tangent with OCCT\'s `ScaleTangents` (CadQuery ' +
  '`scale=True`); false keeps each tangent\'s length as that end\'s magnitude.'
const edgeQuery = () => query('An edge query as returned by `select`.')
const faceQuery = () => query('A face query as returned by `select`.')
const bodyQuery = () => query('A body id such as body_ex1, or a stored body query.')

// A sketch plane resolves through the query repository, so a face query from
// `select` is accepted beside the plane feature ref and the bare name.
const PLANE_QUERY_NOTE =
  '@<planeId>, a bare plane name (Top, Front, Right), or a face query from `select` '
  + '(the stored ?...:flatface string): a face query places the sketch on that face, origin = face centroid. '
  + 'Instead of pasting that query string, `plane` also takes the selector itself as `{selector: <a select '
  + 'selector naming exactly one face>}`; the headless drive resolves it against the settled solve and stores the '
  + 'query it matched, so the document never carries a selector. '
  + 'The measure reply `frames` map reports the resolved origin and axes; a run reports the ones this call '
  + 'touched or moved, and `frames: "all"` restores every resolved frame.'

// The params slot order per entity kind, generated from the entity registry so
// a new kind or a moved slot cannot leave the catalog stale.
const ENTITY_PARAMS_NOTE =
  `Params per kind, in order: ${entityParamLayoutsSentence()}. ` +
  'Arc and ellipse angles are degrees; an arc sweeps counter-clockwise from a0_deg to a1_deg.'

// The DXF import contract. The parser enforces it (utils/dxfImport.ts); this
// note is what an author reads before writing an import step.
const DXF_IMPORT_NOTE =
  'Give exactly one of `content` (the ASCII DXF file text) or `file` (the id of a DXF entry in the run '
  + 'call\'s `files` map; the headless drive reads that confined project path and stores the text, never '
  + 'the path). LINE, ARC, CIRCLE, LWPOLYLINE and a 2D POLYLINE '
  + '(bulges become arcs), a single-span cubic Bezier SPLINE, a full ELLIPSE and POINT import as authored '
  + 'sketch entities with fresh ids, all in one undo entry. TEXT, MTEXT, DIMENSION and the other annotation '
  + 'entities are skipped and counted, as is paper space; any other curve entity (INSERT, HATCH, a multi-span or rational '
  + 'SPLINE, a 3D POLYLINE) refuses the whole file by name so no profile is half imported. $INSUNITS '
  + 'converts to the document unit (0 unitless, 1 inch, 2 foot, 4 mm, 5 cm, 6 m; unitless means document '
  + 'units). Every layer is imported and layer names are not stored; repeated entities are kept. '
  + 'The step reply reports `createdIds: []` and `createdCount`: the import is a bulk add, so the reply '
  + 'carries the entity count, the run reply\'s `docHash` names the document, and the document resource '
  + 'has the ids.'

// The text expansion contract (utils/geometry/textExpand.ts): what the author
// gets and what is refused, so a lettering step can be written blind.
const ADD_TEXT_NOTE =
  'Expands the string once, in Roboto 400, into closed glyph contours of `line` and `spline` entities with '
  + 'fresh ids and no constraints, all in one undo entry; there is no stored text entity, so editing the '
  + 'string later means deleting the outlines and adding new text. `size` is the em size in document units '
  + '(positive, default 10; a capital is about 0.71 em tall), `angle` turns the baseline counter-clockwise in '
  + `degrees (default 0). Kerning is not applied, and there is no multi-line layout. A character outside `
  + `U+0020..U+007E is refused by code point, never dropped, and a run over ${MAX_TEXT_ENTITIES} entities is `
  + 'refused. An extrude of the sketch fills the glyphs even-odd, so counters (o, B) stay open. '
  + 'The step reply reports `createdIds: []` and `createdCount`; the document resource has the ids.'

// The constraint operand grammar an author writes by hand. A sketch-local
// `$<entityId>` is accepted and is what the app stores; the explicit forms name
// the sketch too, so a script can be written without knowing the local ids.
const VERTEX_REF_NOTE =
  'A constraint target may be a sketch-local ref ($<entityId>, as the app stores it) or an explicit ref '
  + 'entity:<sketchId>:<entityId> / vertex:<sketchId>:<entityId>:<key>, where key is start/end on a line, '
  + 'center on a circle, start/end/center on an arc (start is the a0_deg end, end the a1_deg end), '
  + 'center/major1/major2/minor1/minor2 on an ellipse, start/c1/c2/end on a spline, '
  + 'start/fit<k>/end/c1/c2 on a fit_spline, and xy on a point. Builtin refs such as @builtin_origin are also accepted.'

// Every `set_<kind>_field` names one feature kind; the kind's schema
// sub-definition is the one list of fields it may set. The Record makes a new
// setter mutation fail `tsc -b` until it is mapped, and the catalog test names
// any setter this map forgets. Exported so the drift test reads this mapping
// instead of keeping a second copy.
type FieldSetterType = Extract<Mutation['type'], `set_${string}_field`>

export const FIELD_SETTER_KIND = {
  set_plane_definition_field: 'plane',
  set_extrude_field: 'extrude',
  set_revolve_field: 'revolve',
  set_sweep_field: 'sweep',
  set_fillet_field: 'fillet',
  set_chamfer_field: 'chamfer',
  set_shell_field: 'shell',
  set_move_face_field: 'move_face',
  set_boolean_field: 'boolean',
  set_pattern_field: 'pattern',
  set_hole_field: 'hole',
  set_transform_field: 'transform',
  set_mirror_field: 'mirror',
  set_split_field: 'split',
  set_variable_field: 'variable',
  set_helix_field: 'helix',
} as const satisfies Record<FieldSetterType, FeatureKind>

/** The setter mutation that names one kind's fields, read back out of
 *  FIELD_SETTER_KIND so a value note can name that kind's empty-clear fields
 *  without keeping a second table. */
const SETTER_TYPE_BY_KIND = Object.fromEntries(
  Object.entries(FIELD_SETTER_KIND).map(([type, kind]) => [kind, type as FieldSetterType]),
) as Record<FeatureKind, FieldSetterType>

/** The field names a `set_<kind>_field` mutation may name, read from that
 *  kind's part-document schema sub-definition. Null for any other mutation. */
export function setterFieldNames(type: Mutation['type']): readonly string[] | null {
  if (!Object.hasOwn(FIELD_SETTER_KIND, type)) return null
  return featureFieldNames(FIELD_SETTER_KIND[type as FieldSetterType])
}

/** The schema definition of one field a setter may name, so the value check
 *  reads the same contract the saved document is held to. Null when the type is
 *  not a setter or the name is not in the kind's schema. */
export function setterFieldSchema(type: Mutation['type'], field: string): JsonSchema | null {
  if (!Object.hasOwn(FIELD_SETTER_KIND, type)) return null
  const kind = FIELD_SETTER_KIND[type as FieldSetterType]
  const params = kind === 'plane' ? planeDefinitionSchema() : featureParamsSchema(kind)
  if (params === null) return null
  const properties = params.properties as Record<string, JsonSchema> | undefined
  return properties?.[field] ?? null
}

/** True when the kind's schema lists `field` as unconditionally required, so a
 *  null (the setter's clear) would delete a key the loader needs. A field that
 *  is required only under a condition (a blind hole's depth) is not listed. */
export function setterFieldRequired(type: Mutation['type'], field: string): boolean {
  if (!Object.hasOwn(FIELD_SETTER_KIND, type)) return false
  const kind = FIELD_SETTER_KIND[type as FieldSetterType]
  const params = kind === 'plane' ? planeDefinitionSchema() : featureParamsSchema(kind)
  const required = params?.required
  return Array.isArray(required) && required.includes(field)
}

// The value-rule table is part of the boundary's contract, so it is published
// next to the catalog: a test (and a future docs page) reads one name for it.
export { MUTATION_VALUE_RULES } from '@/drive/mutationValues'
export type { ValueRule, ValueViolation, ValueViolationCode } from '@/drive/mutationValues'

const HOLE_FIELD_NOTE =
  `Canonical hole fields: ${featureFieldNames('hole').join(', ')}. ` +
  'The required fields are sketch, diameter, depth_mode; depth is required only for a blind hole. ' +
  'A through_all hole sizes itself from the target body and stores no depth, so omit it. ' +
  'A blind add with no depth keeps the editor default of 20. ' +
  'The optional fields are direction, target, thread, style, cb_diameter, cb_depth, cs_angle, tip, tip_angle, thread_depth; ' +
  'they are all optional in an `add_hole` payload. ' +
  'With no `target` the hole drills the body its drill sites sit on or in (a face sketch whose sites lie on or in ' +
  'the material picks that body even when it is not the first); a site outside every body falls back to the ' +
  'first body and the miss warning names it. ' +
  '`direction` is the sketch plane\'s normal (the default) or its reverse; a face sketch\'s normal ' +
  'points out of the face, so a hole on a face usually wants `reverse`, and a blind hole that misses ' +
  'every site says so when the reverse would cut. ' +
  'A through_all hole drills one way and never cuts the material behind its plane: under `normal` the sites ' +
  'vote for the material side and all drill it (a tie keeps normal), a site with material on the other side is ' +
  'named in a warning, and `reverse` is obeyed as written; the featureDeltas row reports the resolved `direction`. ' +
  '`depth_mode` is blind or through_all. `sketch` is a feature-level ref, so spell it ' +
  '@<sketchId> (or a narrower entity:/vertex:/? pick from the viewport), not the profile consumers\' ' +
  '$<sketchId> form; a $ ref is refused here. ' +
  'The sketch\'s non-construction points and circles are drilled: a circle at its own radius, a point at the feature `diameter`. ' +
  'A circle names its own size, so a sketch whose drill sites are all circles never reads `diameter`, though the document still requires the field and a point site added later does use it. ' +
  'Construction points and circles are reference geometry, so a whole-sketch pick skips them (an n-gon\'s circumcircle, or a point or circle an author flags construction); ' +
  'line endpoints are not drill sites, while add_center_rect\'s helper centre point is an ordinary point and does drill. ' +
  'A single point or circle picked alone drills only that one, and a picked construction one is refused. ' +
  '`style` widens the mouth: `counterbore` reads `cb_diameter` and `cb_depth`, `countersink` reads `cb_diameter` and `cs_angle` (degrees, default 90); absent means `simple`. ' +
  'The widened mouth is one field, `cb_diameter`, under both styles: there is no `cs_diameter` (`cs_angle` is the only `cs_` field). ' +
  '`tip` is a blind hole\'s bottom: `flat` (absent) or `drill_point`, a cone of included angle `tip_angle` (degrees, default 118) ' +
  'under the bore; `depth` stays the full-diameter depth to the shoulder and the point reaches past it. A through_all hole ignores both. ' +
  '`thread_depth` is how deep a `thread` is tapped (drill 20, tap 15), from the origin `depth` is measured from (the entry face for a through hole); ' +
  'absent taps the whole bore below any widened mouth, a value past the bore is clamped with a warning, and a hole without `thread` ignores it. ' +
  'An empty value clears the `target` pick (the key is deleted, and the hole then drills the body its drill sites sit on); ' +
  'null clears an optional field the same way. `sketch` is stored verbatim, so send a sketch id rather than "". ' +
  'An enum or numeric field refuses an empty value instead of silently reverting to its default.'

// The hole payload an `add_hole` may carry, the same field names and value
// contract a `set_hole_field` sets. Every one is optional: a bare add is still
// a half-configured feature the editor completes, and a script can create a
// fully configured hole in one call.
const holeAddFields = () => {
  const properties = (featureParamsSchema('hole')?.properties ?? {}) as Record<string, JsonSchema>
  const thread = properties.thread
  return {
    ...featureAddFields(),
    sketch: optStr('The sketch to drill, as "@<sketchId>" (or a point/circle pick).'),
    diameter: optScalar(),
    depth_mode: optStr('blind | through_all.'),
    depth: optScalar(),
    direction: optStr('normal | reverse.'),
    target: optStr('The body to drill into; the body the drill sites sit on or in when absent. An empty string means absent.'),
    style: optStr('simple | counterbore | countersink (absent means simple).'),
    cb_diameter: optScalar(),
    cb_depth: optScalar(),
    cs_angle: optScalar(),
    tip: optStr('flat | drill_point (absent means flat; blind holes only).'),
    tip_angle: optScalar(),
    thread: thread === undefined ? optObj() : shapedObj(thread, 'The cosmetic thread spec: designation, nominal and pitch.'),
    thread_depth: optScalar(),
  }
}

const SPLIT_NOTE =
  '`above` is the side the plane normal points to, `below` is the other side, and `both` keeps each side as its own body. ' +
  'A picked planar face\'s normal is its OUTWARD normal, so `above` of a face pick is the air side. ' +
  'Builtin normals: Front +Z, Top +Y, Right +X. ' +
  '`bodies` is a list of body refs; a feature ref (@<featureId>) means every body that feature made. ' +
  'With `both` the above half keeps the original body id and every further piece becomes its `_1`, `_2`, ... ' +
  'sibling in geometric order, so @<featureId> still names all of it.'

// The transform has two rotation spellings, one world axis or an Euler triple;
// the solver composes exactly one for the whole feature and refuses a mix,
// because a document that says both cannot mean one placement.
const TRANSFORM_NOTE =
  'One transform applies scale first, then rotation, then translation, equally to every body in `bodies`. ' +
  'For the rotation, name either `rotation_euler` (three numbers in degrees, extrinsic XYZ: rotate about world X first, ' +
  'then world Y, then world Z) or a single axis: `rotation_axis` (a feature-level ref such as @<sketchId>/<entityId>, ' +
  'or an edge query from `select`) or the stored pair `rotation_axis_origin` (VEC3 point) and `rotation_axis_direction` ' +
  '(VEC3, non-zero). The Euler triple is numbers-only: unlike `rotation_angle` its components take no expressions. ' +
  'Its pivot is `rotation_axis_origin` when present, otherwise the world origin. ' +
  'A resolved `rotation_axis` derives both from that edge and overrides the pair; `rotation_axis_direction` alone rotates ' +
  'about the world origin, and `rotation_axis_origin` alone uses +Z. ' +
  '`rotation_euler` cannot be combined with `rotation_axis`, `rotation_angle` or `rotation_axis_direction`; clear the ' +
  'other spelling with a null value (`set_transform_field` with `value: null`) before setting the Euler triple. ' +
  '`translation_from`/`translation_to` and `scale_center_from` are point refs. ' +
  '`rotation_angle` is degrees; `operation: new` keeps the source and emits a new body, `replace` consumes it. ' +
  'One call may carry the whole transform: `bodies` and every field `set_transform_field` sets are accepted inline.'

// The revolve axis resolves through the feature-level query repository, not the
// sketch-local `$` namespace: @sk/entity and edge queries work, `$sk` does not.
const REVOLVE_AXIS_NOTE =
  '`axis` is required and is a feature-level ref, not the profile\'s sketch-local $ form: name a sketch entity as ' +
  '@<sketchId>/<entityId> (a line, or a circle/arc whose center sits on the axis), or an edge query from `select`. ' +
  'A $<sketchId> ref does not resolve in `axis`. The axis may touch the profile boundary but must not cut through ' +
  'its interior.'

// Plane refs are exact on purpose: a case-insensitive bare-name match could
// shadow a user plane whose id differs only by case. The boundary refuses an
// unmatched ref with this list rather than letting the resolver fall back to XY.
const PLANE_REF_NOTE =
  '`plane` is "@builtin_plane_front", "@builtin_plane_top", "@builtin_plane_right", ' +
  'a bare builtin name (Front, Top, Right; case-sensitive), "@<planeId>" for a plane feature, ' +
  'or a "?" face query from `select` (a face sketch takes origin = face centroid, axes from the face normal). ' +
  'An unmatched NAME is refused with the valid names; ' +
  'a name never silently falls back to the XY plane. A face query is resolved after the solve; ' +
  'a plane or face query that does not resolve fails the sketch, naming the cause (a plane defined ' +
  'later in the log tells you to reorder). The measure reply `frames` map reports the resolved ' +
  'frame; a run reports the frames it touched or moved (`frames: "all"` for every resolved frame). ' +
  'docs/drive.md (MCP Server) has the face-frame and add_plane mode tables.'

// The plane modes' frames, per the same tables docs/drive.md serves. Kept short:
// the catalog names where the detail lives so the two cannot disagree on a mode
// the schema adds later without the docs. The parent-ref sentence is the drive
// boundary's vocabulary (mutationValues `planeTargetProblem`); the world-axis
// clause is the Ex015 reading an author brings from CadQuery's local rotate.
const PLANE_MODE_NOTE =
  'Each mode builds a frame: offset keeps the parent axes and moves the origin along the normal; ' +
  'three_point takes p1 as origin and p1->p2 as x; plane_point keeps the parent axes with the origin ' +
  'moved along the normal by the point\'s signed distance from the plane; line_angle takes the line ' +
  'start as origin and the line as x; the face modes take the face centroid and normal ' +
  '(on_face_edge_angle/edge_point take x from the edge); origin_rotation takes its own origin ' +
  '(a point or vertex ref, or three world coordinates, the one plane field that may carry coordinates) ' +
  'and swings the parent axes about rotation_axis ("x", "y", "z" or a direction vector) by rotation_angle ' +
  'degrees, world XY when no plane is named. The parent `plane` is @builtin_plane_front, ' +
  '@builtin_plane_top, @builtin_plane_right, a bare builtin name (Front, Top, Right; case-sensitive), ' +
  '@<planeId>, or a "?" face query from `select`; only offset, plane_point and origin_rotation read it, ' +
  'and a face query parent supplies the face axes and normal. rotation_axis is a WORLD axis in both ' +
  'spellings, not the parent frame\'s own x/y/z. docs/drive.md (MCP Server, add_plane frames) ' +
  'has the exact conventions, and the reply `frames` map reports the frame each plane resolved (a run only ' +
  'for one it touched or moved; `frames: "all"` restores all).'

// One operation, two subjects: a body pattern copies a whole body, a feature
// pattern reapplies one earlier feature's own add or cut inside the body it
// already shaped. The note states the subject fields, the total-count
// convention and the three modes' axis fields, the things an author gets wrong
// first.
const PATTERN_NOTE =
  '`subject` selects what is repeated. `body` (the default) copies `source_body`; `operation: add` unions each ' +
  'copy into the source body when they intersect, while disjoint copies become separate bodies with `_1`, `_2`... ' +
  'siblings and `operation: new` mints one body per copy. `feature` reapplies one earlier extrude, revolve or ' +
  'sweep whose operation is add or cut, inside the body that feature shaped (`source_feature`; `target_body` ' +
  'chooses the body when the source touched more than one). For a feature subject `count` is the TOTAL instance ' +
  'count on one axis, the source\'s own slot included (count 2 adds one copy, count 1 is a no-op). A body subject ' +
  'counts the same way when `include_source` is true; with `include_source: false` every counted slot is a copy. ' +
  'Rectangular mode leaves the seed cell to the source. Linear mode reads `pitch` and ' +
  '`direction` (or `direction_query`); rectangular mode reads `count_x`/`count_y`, `pitch_x`/`pitch_y` and one ' +
  'direction pair per axis; circular mode reads `step_angle` (absent means 360/count) and `axis` (or ' +
  '`axis_origin` + `axis_direction`). A copy that cannot apply is named: some applied and some not is a partial ' +
  'result, and none applied is an error.'

const PATTERN_INLINE_NOTE =
  'One call may carry the whole pattern: ' +
  `${featureFieldNames('pattern').join(', ')} are accepted inline and store the same keys ` +
  '`set_pattern_field` sets.'

const MIRROR_INLINE_NOTE =
  'One call may carry the whole mirror: ' +
  `${featureFieldNames('mirror').join(', ')} are accepted inline and store the same keys ` +
  '`set_mirror_field` sets.'

// Generated from the registry so the example cannot drift: the hand-written
// note named `distance`, a kind the validator refuses (mountPlate F1).
const CONSTRAINT_KIND_NOTE =
  `The constraint kind, one of: ${[...CONSTRAINT_BY_KIND.keys()].join(', ')}. A line's dimension is ` +
  '`length`; two points take `point_distance`.'

// The reply-size rule shared by the sketch copy sugar: `scriptRunner.ts` names
// the ids up to the limit and reports a count past it.
const CREATED_IDS_REPLY_NOTE =
  ` The step reply names the new entity ids up to ${MAX_REPORTED_CREATED_IDS}; past that it reports ` +
  '`createdCount` instead, and the document resource has the ids.'

// Mirror carry-over is the fact an author cannot infer from the mutation shape;
// the rules are pinned in yamlMutations/sketchMirror.ts and its test.
const MIRROR_ENTITIES_NOTE =
  'Each source becomes a new authored entity (fresh ids, mirrored params, the construction flag carried); ' +
  'this is geometry, not a live mirror relation, and editing the source later does not move the copy. ' +
  'Constraints carry when every operand is a source or the axis line (an entity pinned to the axis mirrors to ' +
  'a copy pinned to the same axis): vertex refs remap by position, so a mirrored arc\'s `start` and `end` swap ' +
  '(arcs keep their authored CCW sweep), values are unchanged, and sign-carrying dimensions ' +
  '(`point_distance_x`, `point_distance_y`, `line_distance`, `angle`) flip their side. `horizontal`/`vertical` ' +
  'survive only on a horizontal, vertical, or 45-deg axis (on a 45-deg axis they swap); any other operand ' +
  'outside the mirror set drops that constraint. Projected entities are refused: their geometry re-projects. ' +
  'A source whose mirror is itself (a seam edge on the axis, a line across it, an arc centred on it) gets no ' +
  'copy: the original serves both halves, and its constraints to the other sources carry onto the copies. ' +
  'A one-coordinate `fixed` carries only on a horizontal or vertical axis. A step whose every source mirrors ' +
  'to itself is refused. New entity ids are reported in source order, one per fresh copy; a source that ' +
  'mirrors to itself adds none.' + CREATED_IDS_REPLY_NOTE

// The side is relative to the loop, not to each line's drawn direction, so a
// CW, CCW or projected loop all read the same (birdhouse F3, Case_Seam_Lip F6).
const OFFSET_SIDE_NOTE =
  'When the selected entities close into loops, a positive `distance` moves every copy out of the region the ' +
  'loops bound and a negative one moves it inward, whatever the winding (OpenSCAD `offset(r>0)` and CadQuery ' +
  'positive `offset2D` are outward too); a selected inner loop is a hole, so its positive offset shrinks it. ' +
  'An open selection keeps the per-entity rule: a line moves along the left normal of its start->end direction ' +
  'and a circle or arc grows its radius.'

// The fillet's authored-arc contract is what an author cannot infer from the
// mutation shape; the rules are pinned in yamlMutations/sketchFillet.ts and its
// test.
const FILLET_CORNERS_NOTE =
  'Each corner trims the named endpoint of both straight sides to its tangent point and adds one authored ' +
  'arc joining them; this is geometry, not a live fillet relation, so editing a side later does not move ' +
  'the arc. The radius must be strictly less than both side lengths, and two corners sharing a line must ' +
  'leave a segment on it. Both sides must be lines of the same sketch; an arc, circle, spline, ellipse or ' +
  'projected side is refused, as is a corner whose sides already meet tangentially. The material side is ' +
  'probed from the whole sketch profile unless `side` names it; a mixed construction/normal corner is ' +
  'refused, and the arc is construction only when both sides are. The coincident joint between the two ' +
  'trimmed endpoints is consumed. A second coincident, a tangent between the sides, or a `fixed` or ' +
  'dimension that anchors a trimmed endpoint is refused by constraint id. Arc params are ' +
  '`[cx, cy, r, a0_deg, a1_deg]` and keep the CCW sweep. The step reply reports one new arc id per ' +
  'corner in `corners` order.' + CREATED_IDS_REPLY_NOTE

// What an author cannot read off the field list: the copies are plain rows,
// the count includes the source, where the new ids land, and which
// constraints follow. The rules are pinned in yamlMutations/sketchPattern.ts
// and its tests.
const PATTERN_ENTITIES_NOTE =
  'Repeats the source entities as authored geometry inside one sketch (or, in copy mode, into another sketch on ' +
  'the same plane); there is no live pattern relation, so editing a source later does not move the copies. ' +
  'Modes: linear reads count, pitch and direction (default [1, 0]); grid reads count and count2 with pitch/pitch2 ' +
  'along direction/direction2 (defaults [1, 0] and [0, 1]); rotate reads count, angle_deg (the step) and center ' +
  '(default [0, 0]); copy makes one copy, rotated by angle_deg about center and then moved by translate. A field ' +
  `from another mode is refused. count includes the source and the step makes at most ${MAX_PATTERN_INSTANCES} ` +
  `instances; the sketch holds at most ${MAX_SKETCH_ENTITIES} entities. A copy that lands on the source or an ` +
  'earlier copy is refused. New ids are minted in one block, instance by instance in sourceIds order, and the ' +
  'step reply reports them in that order (in copy mode, in the target sketch). A constraint is copied only ' +
  'when every operand is a source; one that ties a source to anything else stays on the source alone. ' +
  'horizontal/vertical, ' +
  'point_distance_x/y, a midpoint axis and a one-coordinate fixed swap at a quarter turn and are dropped at any ' +
  'other angle. Projected sources are refused. Copy-mode targetFeatureId must name a sketch on the same plane ' +
  '(Front and @builtin_plane_front are one plane); this never reflects, which is mirror_entities.' +
  CREATED_IDS_REPLY_NOTE

const VARIABLE_NAME_NOTE =
  'An expression refers to a variable by the variable feature\'s `label` (the name; `add_variable` sanitizes it to an ' +
  'identifier and suffixes `_2`, `_3`... on a clash), not by its featureId: `label: width` is used as `width * 2`.'

// merge_target is a body id, not a ref: the practice runs guessed `@body_ex5`.
const MERGE_TARGET_NOTE =
  'The bare body id the cut or add goes into, e.g. `body_ex5` (no @ sigil). Absent means automatic: a cut ' +
  'reaches every body, and an add fuses the first body it reaches. On an extrude, a body the new solid only ' +
  'shares a face with is reported by the touch warning, not fused, so an overlap is not required for the ' +
  'warning to name it. ' +
  'The feature\'s featureDeltas row names a body the feature changed as `body`, with its own ' +
  '`bodyVolume`: a merge_target cut\'s own receiving body when the cut changed it.'

// Up-to was documented in the document schema and the document guide but not in
// the mutation catalog, so a client authored the key it had to infer (Ex100).
// The spelling list follows resolveUpToPlane: only absolute/query refs resolve.
const EXTRUDE_UP_TO_NOTE =
  '`termination: up_to` ends the extrude at the element `up_to` names instead of at `distance`: ' +
  '`@builtin_plane_front`/`@<planeId>` for a plane (`@<planeId>` is the spelling `add_sketch.plane` takes); ' +
  'a planar body face (a face query from `select`, or the viewport\'s `@<bodyId>/face/<n>` fallback); ' +
  'a `select` vertex query, or a sketch point ref (`@<sketchId>/<entityId>/xy`). ' +
  'A query target that does not resolve or matches several elements falls back to `distance` with a warning ' +
  '(`used blind distance`); an up_to with no `up_to` target does so too, with `up_to has no target; used blind distance`. ' +
  'A `@<bodyId>/face/<n>` ref that no longer names a face (the body is gone, the index is out of range, or the ' +
  'remap fails) fails the feature instead of falling back: that ref is a persisted pick. ' +
  'A non-planar face is refused, and so is `up_to` with `direction: symmetric`. `up_to` is read only when ' +
  '`termination` is `up_to`; otherwise it is ignored.'

// A through-all cut used to be a guessed blind distance (CadQuery cutThruAll,
// the kcl 80-20 rail); a part that later grows past the guess silently stops
// being cut. The termination sizes from the bodies instead.
const EXTRUDE_THROUGH_ALL_NOTE =
  '`termination: through_all` is a CUT that is sized from the bodies it can reach instead of from ' +
  '`distance`, which it ignores: `merge_target` narrows the reach and the cut to one body, and with no ' +
  'target every body is a candidate, so a body farther along the same axis only makes the tool longer. ' +
  'It needs a body to cut through, and `operation` must be `cut`; add, new and intersect are refused.'

const REVOLVE_INLINE_NOTE =
  'One call may carry the whole revolve: `direction` (normal | reverse | symmetric), `operation` ' +
  '(add | cut | new) and `merge_target` set the same keys `set_revolve_field` does; with no `operation` ' +
  'a revolve adds to the body it touches. `merge_target`: ' + MERGE_TARGET_NOTE

// The product has no loft: a multisection sweep is justified because the path
// pierces each section, where a loft has no defined surface between them. The
// hole limit is named with the two-sweep workaround because the refusal alone
// leaves a ring author no way forward.
const SWEEP_MULTISECTION_NOTE =
  'A blend between section sketches is `sweep.multisection`: two or more sections, each pierced by the ' +
  'same path. There is no loft feature. Each section is one outer loop. A section with a hole is refused; ' +
  'sweep the outer loops in an `add` sweep and the inner loops in a second `cut` sweep of the same path, ' +
  'using the one-loop `entity:<sketchId>:<entityId>` refs and naming the cut\'s `merge_target` so the cut ' +
  'cannot reach an unrelated body.'

const SWEEP_INLINE_NOTE =
  'One call may carry the whole sweep: `transition` (mitre | round), `multisection`, `operation` ' +
  '(add | cut | new) and `merge_target` set the same keys `set_sweep_field` does; with no `operation` ' +
  'a sweep adds to the body it touches. Sections on other planes are added with `add_sweep_profile`, ' +
  'then `multisection: true` in the same add call; each section must be pierced by the path. ' +
  SWEEP_MULTISECTION_NOTE + ' `merge_target`: ' + MERGE_TARGET_NOTE

const EXTRUDE_ADD_NOTE =
  'An `add` extends an existing body: with no `merge_target` it fuses the first body its profile reaches, and ' +
  'a profile that reaches none fails the feature (`add does not merge with any existing body`). Start a new ' +
  'body with `operation: new`. An add that fuses one body and also reaches another reports the untouched ' +
  'body in `solver_warning`.'

// The symmetric split is the one direction whose distance reads two ways
// (sprocket, ppp0103 F2, ppp0105 F3).
const EXTRUDE_FIELDS_NOTE =
  '`direction: symmetric` takes `distance` as the TOTAL length, half on each side of the sketch plane ' +
  '(distance 10 spans -5..+5); `normal` and `reverse` take it whole on one side. `merge_target`: ' + MERGE_TARGET_NOTE +
  ' ' + EXTRUDE_UP_TO_NOTE + ' ' + EXTRUDE_THROUGH_ALL_NOTE

// Construction lines divide the sketch's pickable pieces but must not divide the
// solid: the profile fuses collinear pieces before the wire is built.
const COLLINEAR_PROFILE_NOTE =
  'A sketch line split by a construction line, and collinear lines that meet end to end, fuse into one ' +
  'lateral face; the sketch keeps its pieces and its area division.'

const EXTRUDE_INLINE_NOTE =
  'One call may carry the whole extrude: `direction`, `termination`, `up_to`, `operation` and `merge_target` set ' +
  'the same keys `set_extrude_field` does. ' + EXTRUDE_FIELDS_NOTE + ' ' + EXTRUDE_ADD_NOTE + ' ' +
  COLLINEAR_PROFILE_NOTE

// The boolean refuses to solve without a target and a tool, so the catalog
// names them up front (Case_Seam_Lip F5).
const BOOLEAN_INLINE_NOTE =
  'Solving needs `target` (one body id) and at least one entry in `tools`; `operation` defaults to union. ' +
  'One call may carry the whole boolean: `operation`, `target`, `tools`, `keep_tools` and `clearance` set ' +
  'the same keys `set_boolean_field` does. `keep_tools` keeps the tool bodies after a subtract; `clearance` ' +
  'offsets a subtract tool (positive grows it, negative shrinks it). ' +
  '`set_boolean_field` and `add_boolean_tool` remain for later edits.'

const BOOLEAN_ARRAY_TOOL_NOTE =
  'A `tools` entry naming a body-subject pattern feature (`@<patternId>`) expands at solve time to that ' +
  'pattern\'s source body and every instance body, including the `<source>_N` copies an `operation: add` pattern ' +
  'splits into, so it follows a later count change; the target is left out of ' +
  'the expansion; the pattern must come before the boolean in the log (a later one is refused as unresolved). A hand-typed list that names only some of ' +
  'one pattern\'s bodies solves with a warning (also when the split is deliberate). A feature-subject pattern is not an array of bodies and is not expanded.'

// Same precedence as transform's rotation axis, so one rule covers both.
const CIRCULAR_AXIS_NOTE =
  'The rotation axis is `axis` (an edge, sketch entity or face ref), or the stored pair `axis_origin` (VEC3 point) ' +
  'and `axis_direction` (VEC3, non-zero). A resolved `axis` overrides the pair; `axis_direction` alone rotates about ' +
  'the world origin, and `axis_origin` alone uses +Z.'

// The fillet and chamfer edge list is a pick list like a shell's faces, so each
// entry takes the same two spellings.
const EDGE_PICK_LIST_NOTE =
  'Each `edges` entry is an edge query from `select`, or `{selector: <a select selector>}`: a selector expands to ' +
  'one entry per edge it matches, so one entry can name several edges. The headless drive resolves a selector ' +
  'against the settled solve before the add applies; the document stores only query strings.'

const FILLET_BULK_NOTE =
  'One call may carry the whole pick: `edges` appends the query strings `select` returned, and `radius` sets the ' +
  'radius in the same step. `add_fillet_edge` and `set_fillet_field` remain for later single-edge and field edits. ' +
  'The blend continues along the pick\'s whole tangent chain (OCC joins edges that meet tangentially), so one ' +
  'edge of a rounded loop rounds all of it and the reply notes the edge count. ' + EDGE_PICK_LIST_NOTE

const CHAMFER_BULK_NOTE =
  'One call may carry the whole pick: `edges` appends the query strings `select` returned, and `distance` sets the ' +
  'distance in the same step. `add_chamfer_edge` and `set_chamfer_field` remain for later single-edge and field edits. ' +
  'The chamfer continues along the pick\'s whole tangent chain (OCC joins edges that meet tangentially), so one ' +
  'edge of a rounded loop bevels all of it and the reply notes the edge count. ' + EDGE_PICK_LIST_NOTE

// The shell has no signed thickness: `thickness` is a magnitude and the
// direction field carries the side. CadQuery's `.shell()` takes a signed
// thickness and its negative value is the inward one, so a translated model
// flips the sign into `direction` rather than passing it through.
// Ex017: the sign mapping alone read as "the same solid". The join has to be
// named too. applyShellWithLineage builds with OCC's intersection join by
// default; CadQuery's default `kind="arc"` rounds outer corners instead. The
// `join` field selects between them: `sharp` (default) or `arc`.
const SHELL_SIGN_NOTE =
  '`thickness` is always positive and a negative value is refused; the side is carried by `direction: inward|outward`. ' +
  'The default is `inward` (the outer skin stays where it is and material is removed from inside). ' +
  "CadQuery's signed thickness maps as positive -> `outward` and negative -> `inward`, with the magnitude as " +
  '`thickness`. ' +
  '`join` selects the corner treatment: `sharp` (default, OCC\'s intersection join, keeps authored corners) or ' +
  '`arc` (fills the offset gap with a quarter cylinder of radius = thickness: outward rounds convex outer ' +
  'corners, inward rounds concave inner ones; CadQuery\'s default `kind="arc"` maps to `join: "arc"`, and ' +
  '`kind="intersection"` to the default). ' +
  'The sharp build falls back to arc only when it genuinely refuses (a removed face bounded by fillets); with ' +
  '`join: "arc"` the arc build is used directly and no fallback note is emitted.'

const SHELL_BULK_NOTE =
  'One call may carry the whole pick: `faces` appends the query strings `select` returned, and `thickness`, ' +
  '`direction` and `join` set the wall in the same step. `add_shell_face` and `set_shell_field` remain for later ' +
  'single-face and field edits. ' + SHELL_SIGN_NOTE

// The shell face list is a pick list like a fillet's edges, so each entry takes
// the same two spellings.
const SHELL_FACES_NOTE =
  'Each `faces` entry is a face query from `select`, or `{selector: <a select selector>}`: a selector expands to ' +
  'one entry per face it matches, so one entry can open several faces. The headless drive resolves a selector ' +
  'against the settled solve before the shell applies; the document stores only query strings.'

const fieldOf = (label: string, type: FieldSetterType) =>
  str(`The ${label} field to set. Valid fields: ${(setterFieldNames(type) ?? []).join(', ')}.`)
// A setter value's real type is the named schema field's; name that definition
// instead of trying to restate every feature field's union here. The enum
// members are generated from the schema, so a renamed value cannot go stale, and
// the empty-clear sentence names exactly the fields EMPTY_REF_CLEARS admits, so
// the note cannot promise a clear the boundary refuses.
const EMPTY_CLEAR_NOTE = (type: FieldSetterType): string => {
  const clears = [...(EMPTY_REF_CLEARS[type] ?? [])].map(name => `\`${name}\``)
  const empty = clears.length === 0
    ? ' An empty value is refused: it is the clear of no field of this kind.'
    : ` An empty value clears ${clears.join(' or ')} and is refused for every other field.`
  return ' A null value clears an optional field (the key is deleted); '
    + 'null on a required field is refused by name.' + empty
}

const setterValue = (kind: FeatureKind) =>
  anyValue(
    `The new value for the named field; its type follows FEATURE_SCHEMA_BY_KIND.${kind} in persistence/partDocSchema.ts.`
    + enumFieldsNote(kind)
    + EMPTY_CLEAR_NOTE(SETTER_TYPE_BY_KIND[kind]),
  )
const planeDefinitionValue = () =>
  ({
    type: 'scalar',
    required: true,
    note: 'The new value for the named plane definition field; its type follows PLANE_DEF in persistence/partDocSchema.ts.'
      + enumFieldsNote('plane')
      + ' An empty value is refused. A null value is refused too (the wire requires a scalar); '
      + 'this mutation cannot delete a plane definition field. origin_rotation\'s vector fields take only '
      + 'their scalar spelling here (origin a point ref, rotation_axis an "x"/"y"/"z" letter); author the '
      + 'coordinate or vector spelling in add_plane\'s definition object.',
  } as const)

/** The enum-valued fields of a feature kind, as `name: a|b|c`, read from the
 *  kind's schema so the note follows the union rather than a second list. A
 *  property the schema also describes carries that sentence with it, so a
 *  value whose meaning is not obvious (hole.direction) is explained in the
 *  catalog instead of needing a hand-kept second copy. */
function enumFieldsNote(kind: FeatureKind): string {
  const params = featureParamsSchema(kind)
  if (params === null) return ''
  const entries: string[] = []
  for (const [name, property] of Object.entries(params.properties as Record<string, JsonSchema>)) {
    if (!Array.isArray(property.enum)) continue
    const description = typeof property.description === 'string' ? ` (${property.description})` : ''
    entries.push(`${name}: ${property.enum.join('|')}${description}`)
  }
  return entries.length === 0 ? '' : ` Enum fields: ${entries.join('; ')}.`
}

export const MUTATION_CATALOG = {
  move_vertex: {
    summary: 'Drag one sketch vertex to a point (gesture plumbing).',
    hidden: true,
    fields: {
      featureId: str(),
      entityId: str(),
      vertexKey: str(),
      to: point(),
      solvedGeometry: solvedGeometry(),
    },
  },
  move_vertex_with_constraint: {
    summary: 'Drag a sketch vertex and pin it to a snap target (gesture plumbing).',
    hidden: true,
    fields: {
      featureId: str(),
      entityId: str(),
      vertexKey: str(),
      to: point(),
      constraintKind: str(),
      snapVertexId: optStr(),
      snapEntityRef: optStr(),
      solvedGeometry: solvedGeometry(),
    },
  },
  move_entity: {
    summary: 'Drag one sketch entity by a delta.',
    fields: {
      featureId: str(),
      entityId: str(),
      delta: point(),
      solvedGeometry: solvedGeometry(),
    },
  },
  resize_circle: {
    summary: 'Resize one sketch circle by a new radius.',
    fields: {
      featureId: str(),
      entityId: str(),
      radius: num(),
      solvedGeometry: solvedGeometry(),
    },
  },
  add_constraint: {
    summary: 'Add a sketch constraint over entity refs.',
    note: VERTEX_REF_NOTE,
    fields: {
      featureId: str(),
      kind: str(CONSTRAINT_KIND_NOTE),
      targets: arr('Entity or vertex refs the constraint names; see the row note for the spelling.'),
      value: optNum(),
      pos: optPoint(),
      sign: optNum(),
    },
  },
  set_constraint_value: {
    summary: 'Set a dimension constraint value.',
    fields: { featureId: str(), constraintId: str(), value: num() },
  },
  set_constraint_pos: {
    summary: 'Move a dimension label.',
    fields: { featureId: str(), constraintId: str(), pos: point() },
  },
  set_constraint_sign: {
    summary: 'Flip a signed dimension.',
    fields: { featureId: str(), constraintId: str(), sign: num() },
  },
  delete: {
    summary: 'Delete sketch entities, vertices or constraints.',
    fields: {
      targets: arr(
        'Sketch targets to delete: "entity:<sketchId>:<entityId>", ' +
        '"vertex:<sketchId>:<entityId>:<vertexKey>" or "constraint:<sketchId>:<constraintId>". ' +
        'Features are deleted with delete_feature, not with a sketch target.',
      ),
    },
  },
  add_entity: {
    summary: 'Add one sketch entity of a kind with numeric params.',
    fields: {
      featureId: str(),
      kind: str('Entity kind: line, circle, arc, ellipse, spline, fit_spline or point. A fit_spline takes its flat fit points plus optional tangents/tangentScale.'),
      params: arr(ENTITY_PARAMS_NOTE),
      entityId: optStr(),
      tangents: optArr(FIT_SPLINE_TANGENTS_NOTE),
      tangentScale: optBool(FIT_SPLINE_TANGENT_SCALE_NOTE),
    },
  },
  import_dxf: {
    summary: 'Import the entities of an ASCII DXF profile into a sketch.',
    note: DXF_IMPORT_NOTE,
    fields: {
      featureId: str('The sketch feature the imported entities land in.'),
      content: optStr('The ASCII DXF file text; give this or `file`, not both.'),
      file: optStr('The id of a DXF entry in the run call\'s files map; give this or `content`, not both.'),
    },
  },
  add_text: {
    summary: 'Write a string into a sketch as authored glyph outlines (lines and cubic splines).',
    note: ADD_TEXT_NOTE,
    fields: {
      featureId: str('The sketch the outlines land in.'),
      text: str('Printable ASCII (U+0020..U+007E), one line.'),
      origin: optPoint('The baseline start in sketch coordinates; default [0, 0].'),
      size: optNum(),
      angle: optNum(),
      align: optStr('left | center | right: which part of the run sits on origin; default left.'),
    },
  },
  insert_fit_point: {
    summary: 'Insert one fit point into a fit spline at a positional index.',
    fields: {
      featureId: str(),
      entityId: str(),
      index: num('Insertion index, 0..N (N appends after the last point).'),
      point: point(),
    },
  },
  set_fit_spline_handle: {
    summary: 'Set or remove one end handle of a fit spline.',
    fields: {
      featureId: str(),
      entityId: str(),
      end: str('Which end: start or end.'),
      handle: anyValue('Absolute handle point [x, y], or null to remove the handle.'),
    },
  },
  add_entity_with_constraint: {
    summary: 'Add a sketch entity and pin one of its vertices to a snap target.',
    note: '`vertexKey` names the new entity vertex the snap constraint attaches: start/end on a line, center on a circle, start/end/center on an arc (start is the a0_deg end), center/major1/major2/minor1/minor2 on an ellipse, start/c1/c2/end on a spline, xy on a point, start/fit<k>/end/c1/c2 on a fit_spline.',
    fields: {
      featureId: str(),
      kind: str('Entity kind: line, circle, arc, ellipse, spline, fit_spline or point. A fit_spline takes its flat fit points plus optional tangents/tangentScale.'),
      params: arr(ENTITY_PARAMS_NOTE),
      vertexKey: str(),
      snapVertexId: optStr(),
      snapEntityRef: optStr(),
      constraintKind: str(),
      entityId: optStr(),
      tangents: optArr(FIT_SPLINE_TANGENTS_NOTE),
      tangentScale: optBool(FIT_SPLINE_TANGENT_SCALE_NOTE),
    },
  },
  add_projected_entity: {
    summary: 'Project a body edge into a sketch as an entity.',
    fields: { featureId: str(), kind: str(), source: str('The source edge ref.'), entityId: optStr() },
  },
  add_rect: {
    summary: 'Add an axis-aligned rectangle with its lines and constraints; '
      + 'the created line ids are ordered bottom, right, top, left.',
    fields: {
      featureId: str(),
      p0: point(),
      p1: point(),
      p0Ref: nullableStr(),
      p1Ref: nullableStr(),
      entityIds: optArr('Optional authored ids for the four lines, in bottom, right, top, left order. '
        + 'The list must hold exactly 4 ids, each unused in the sketch.'),
    },
  },
  add_center_rect: {
    summary: 'Add a rectangle by centre and corner.',
    note: '`corner` is the half-diagonal corner: the rectangle mirrors it through `center`, so '
      + 'center [0,0] with corner [1,1] gives a 2x2 rectangle. The feature also leaves a centre point entity '
      + '(not construction geometry) that the diagonal midpoint constraint references; delete it if it is not wanted. '
      + 'The created entity ids are the four lines, then the centre point: line 1 lies on the mirrored corner\'s y, '
      + 'line 2 on `corner`\'s x, line 3 on `corner`\'s y, line 4 on the mirrored corner\'s x. With `corner` up and right '
      + 'of `center` that is bottom, right, top, left, the add_rect order.',
    fields: {
      featureId: str(),
      center: point(),
      corner: point(),
      centerRef: nullableStr(),
      cornerRef: nullableStr(),
      entityIds: optArr('Optional authored ids for the four lines then the centre point (5 ids); '
        + 'the lines are in bottom, right, top, left order, each id unused in the sketch.'),
    },
  },
  add_ngon: {
    summary: 'Add a regular polygon by centre, corner and side count.',
    note: 'The created entity ids are the n lines in chain order, then the construction circumcircle.' +
      CREATED_IDS_REPLY_NOTE,
    fields: {
      featureId: str(),
      center: point(),
      corner: point(),
      sides: num(),
      centerRef: nullableStr(),
      cornerRef: nullableStr(),
      entityIds: optArr('Optional authored ids for the n lines in chain order then the construction '
        + 'circumcircle (sides + 1 ids), each unused in the sketch.'),
    },
  },
  add_three_point_arc: {
    summary: 'Add an arc through three points: a start, a point on the arc, and an end.',
    note: '`start` is the first point, `through` lies on the arc, and `end` is the last, the order of '
      + 'CadQuery\'s threePointArc. The arc is stored counter-clockwise from a0_deg to a1_deg, so the vertex key '
      + 'at the given start is `start` when start -> through -> end runs counter-clockwise and `end` when it runs '
      + 'clockwise. The through point also picks the side, so a through point beyond the chord gives the major arc '
      + '(a sweep over 180 degrees). Without refs the stored centre, radius and angles are rounded to the 1e-6 '
      + 'document grid, so the arc ends land within about 1e-6 of the given points, inside the 1e-5 loop closure '
      + '(a profile closes), but they are not constrained to a neighbour. `startRef` and `endRef` name what each '
      + 'end snapped to, a `vertex:` ref such as vertex:sk1:l1:end or an `entity:` ref for a point on that curve, '
      + 'and pin that end with a coincident. An arc given by centre and angles is still add_entity kind: arc. '
      + 'The step reply names the arc id followed by its constraint ids, up to two, and carries `vertexKeys`: '
      + 'an object whose `start` and `end` fields name the stored vertex key ("start" or "end") that holds each of '
      + 'the given start and end points, so the next step can write vertex:<sketchId>:<arcId>:<key>.',
    fields: {
      featureId: str(),
      start: point('The first end of the arc.'),
      through: point('A point on the arc; it picks which side of the chord the arc takes.'),
      end: point('The other end of the arc.'),
      startRef: nullableStr(),
      endRef: nullableStr(),
      entityId: optStr('Optional authored arc id, unused in the sketch.'),
    },
  },
  apply_offset: {
    summary: 'Offset sketch entities by a distance. Each sourceId must name an entity in the featureId sketch; '
      + 'a connected chain (coincident or coordinate-joined) is refitted corner to corner: a sharp joint is '
      + 'mitred on the offset curves, and only a joint the sources already meet tangentially keeps a `tangent`.',
    note: OFFSET_SIDE_NOTE,
    fields: { featureId: str(), sourceIds: arr(), distance: num('Signed; see the row note for the side.') },
  },
  mirror_entities: {
    summary: 'Mirror sketch entities about a line of the same sketch, adding the mirrored copies as authored geometry.',
    note: MIRROR_ENTITIES_NOTE,
    fields: {
      featureId: str(),
      sourceIds: arr('Bare entity ids of the featureId sketch; the axis may not be one of them, and projected entities are refused.'),
      line: str('Entity id of one line-kind entity of the same sketch (normal or construction); it is the axis and is not mirrored.'),
    },
  },
  fillet_corners: {
    summary: 'Round one or more sketch corners by trimming both straight sides and adding a tangent arc.',
    note: FILLET_CORNERS_NOTE,
    fields: {
      featureId: str(),
      radius: num('The fillet radius, strictly less than both side lengths at every corner.'),
      corners: arr('Non-empty list of { a, aVertex, b, bVertex, side? }: bare entity ids of two line entities in the featureId sketch, each with the endpoint key that meets at the corner; side is convex or concave and skips the material probe.'),
    },
  },
  pattern_entities: {
    summary: 'Repeat sketch entities as authored copies: linear, grid, rotate, or one transformed copy (optionally into another sketch on the same plane).',
    note: PATTERN_ENTITIES_NOTE,
    fields: {
      featureId: str('The sketch holding the sources.'),
      sourceIds: arr('Bare entity ids of the featureId sketch; projected entities are refused.'),
      mode: str('linear | grid | rotate | copy.'),
      count: optNum(),
      count2: optNum(),
      pitch: optNum(),
      pitch2: optNum(),
      direction: optPoint('linear/grid: the step direction, normalized; default [1, 0].'),
      direction2: optPoint('grid: the second direction, normalized; default [0, 1].'),
      angle_deg: optNum(),
      center: optPoint('rotate/copy: the rotation centre in sketch coordinates; default [0, 0].'),
      translate: optPoint('copy: the move applied after the rotation.'),
      targetFeatureId: optStr('copy: another sketch on the same plane to copy into; default the source sketch.'),
    },
  },
  toggle_construction: {
    summary: 'Toggle construction mode on sketch entities.',
    fields: {
      targets: arr('Entity targets of the form "entity:<sketchId>:<entityId>"; a bare id is refused.'),
    },
  },
  set_feature_plane: {
    summary: 'Move a sketch to another plane.',
    note: PLANE_REF_NOTE,
    fields: { featureId: str(), plane: queryOrSelector(PLANE_QUERY_NOTE) },
  },
  add_sketch: {
    summary: 'Add a sketch feature, optionally on a plane.',
    note: PLANE_REF_NOTE,
    fields: {
      featureId: str(),
      label: optStr(),
      plane: optQueryOrSelector(PLANE_QUERY_NOTE),
      insertAt: insertAt(),
    },
  },
  delete_feature: {
    summary: 'Delete a feature; dependents stay and report the missing input.',
    fields: { featureId: str() },
  },
  set_feature_visibility: {
    summary: 'Show or hide a feature.',
    fields: { featureId: str(), visible: bool() },
  },
  add_plane: {
    summary: 'Add a construction plane feature.',
    note: PLANE_MODE_NOTE,
    fields: {
      ...featureAddFields(),
      definition: shapedObj(planeDefinitionSchema(), 'The plane definition object; the schema lists its modes and fields.'),
      before: optStr('A feature id; the new plane is inserted directly above it instead of appended.'),
    },
  },
  set_plane_definition_field: {
    summary: 'Set one field of a construction plane definition.',
    fields: { featureId: str(), field: fieldOf('plane definition', 'set_plane_definition_field'), value: planeDefinitionValue() },
  },
  rename_feature: {
    summary: 'Rename a feature.',
    fields: { featureId: str(), label: str() },
  },
  toggle_sketch_plane_visibility: {
    summary: 'Toggle every sketch plane overlay.',
    fields: {},
  },
  toggle_plane_visibility: {
    summary: 'Toggle every construction plane overlay.',
    fields: {},
  },
  add_extrude: {
    summary: 'Extrude a sketch along its plane normal, optionally with its direction, termination, operation and merge target.',
    note: EXTRUDE_INLINE_NOTE,
    fields: {
      ...featureAddFields(),
      sketchQuery: sketchQuery(),
      distance: num(),
      direction: optStr('normal | reverse | symmetric; defaults to normal (the key the document stores as extrude.direction).'),
      termination: optNullableStr('blind | up_to | through_all; defaults to blind. `up_to` ends the extrude at the `up_to` element instead of at `distance`; `through_all` is a cut sized from the bodies it can reach, so `distance` is ignored and `merge_target` narrows the reach (the key the document stores as extrude.termination). A null value clears it, so the add writes no key.'),
      up_to: optNullableStr('The element an up_to extrude stops at: `@<planeId>`, `@builtin_plane_front`, a planar body face (a face query from `select`, or the viewport\'s `@<bodyId>/face/<n>` fallback), a `select` vertex query, or a sketch point ref (`@<sketchId>/<entityId>/xy`) (the key the document stores as extrude.up_to). Read only when `termination` is `up_to`; otherwise it is ignored. A null or empty value clears it.'),
      operation: optStr('add | cut | new; absent means add (the key the document stores as extrude.operation).'),
      merge_target: optStr(MERGE_TARGET_NOTE),
    },
  },
  set_extrude_field: {
    summary: 'Set one extrude field (distance, direction, operation, ...).',
    note: EXTRUDE_FIELDS_NOTE,
    fields: { featureId: str(), field: fieldOf('extrude', 'set_extrude_field'), value: setterValue('extrude') },
  },
  add_extrude_profile: {
    summary: 'Add a profile sketch to an extrude.',
    fields: { featureId: str(), sketchQuery: sketchQuery() },
  },
  remove_extrude_profile: {
    summary: 'Remove a profile from an extrude by index.',
    fields: { featureId: str(), index: num() },
  },
  add_revolve: {
    summary: 'Revolve a sketch about a picked axis, optionally with its direction, operation and merge target.',
    note: REVOLVE_AXIS_NOTE + ' ' + REVOLVE_INLINE_NOTE,
    fields: {
      ...featureAddFields(),
      sketchQuery: sketchQuery(),
      angle: num(),
      axis: query(REVOLVE_AXIS_NOTE),
      direction: optStr('normal | reverse | symmetric; defaults to normal (the key the document stores as revolve.direction).'),
      operation: optStr('add | cut | new; absent means add (the key the document stores as revolve.operation).'),
      merge_target: optStr(MERGE_TARGET_NOTE),
    },
  },
  set_revolve_field: {
    summary: 'Set one revolve field.',
    note: REVOLVE_AXIS_NOTE + ' `merge_target`: ' + MERGE_TARGET_NOTE,
    fields: { featureId: str(), field: fieldOf('revolve', 'set_revolve_field'), value: setterValue('revolve') },
  },
  add_revolve_profile: {
    summary: 'Add a profile sketch to a revolve.',
    fields: { featureId: str(), sketchQuery: sketchQuery() },
  },
  remove_revolve_profile: {
    summary: 'Remove a profile from a revolve by index.',
    fields: { featureId: str(), index: num() },
  },
  add_sweep: {
    summary: 'Sweep a profile sketch along a path sketch, optionally with its transition, multisection, operation and merge target.',
    note: SWEEP_INLINE_NOTE,
    fields: {
      ...featureAddFields(),
      sketchQuery: sweepSketchQuery(),
      pathQuery: pathQuery(),
      transition: optStr('mitre | round; absent means mitre.'),
      multisection: optBool(),
      operation: optStr('add | cut | new; absent means add (the key the document stores as sweep.operation).'),
      merge_target: optStr(MERGE_TARGET_NOTE),
    },
  },
  set_sweep_field: {
    summary: 'Set one sweep field.',
    fields: { featureId: str(), field: fieldOf('sweep', 'set_sweep_field'), value: setterValue('sweep') },
  },
  add_sweep_profile: {
    summary: 'Add a profile sketch to a sweep.',
    fields: { featureId: str(), sketchQuery: sweepSketchQuery() },
  },
  remove_sweep_profile: {
    summary: 'Remove a sweep profile by index.',
    fields: { featureId: str(), index: num() },
  },
  add_sweep_path: {
    summary: 'Add a path sketch to a sweep.',
    fields: { featureId: str(), pathQuery: pathQuery() },
  },
  remove_sweep_path: {
    summary: 'Remove a sweep path by index.',
    fields: { featureId: str(), index: num() },
  },
  add_import_step: {
    summary: 'Import a STEP file as a feature.',
    fields: {
      ...featureAddFields(),
      fileId: str('The files entry id carrying the bytes.'),
      scale: optScalar('A uniform scale, number or expression, applied to the imported shape. An inch document stores 1/25.4 here so the file keeps its physical size.'),
    },
  },
  add_fillet: {
    summary: 'Add a fillet feature, optionally with its edges and radius in the same call.',
    note: FILLET_BULK_NOTE,
    fields: {
      ...featureAddFields(),
      edges: optArr('Edge queries from `select`, or `{selector}` entries such as `edges: [{selector: ...}]` the drive resolves; the same array the document stores as fillet.edges.'),
      radius: optScalar('A positive number or an expression string; defaults to 1 when omitted.'),
    },
  },
  add_chamfer: {
    summary: 'Add a chamfer feature, optionally with its edges and distance in the same call.',
    note: CHAMFER_BULK_NOTE,
    fields: {
      ...featureAddFields(),
      edges: optArr('Edge queries from `select`, or `{selector}` entries such as `edges: [{selector: ...}]` the drive resolves; the same array the document stores as chamfer.edges.'),
      distance: optScalar('A positive number or an expression string; defaults to 1 when omitted.'),
    },
  },
  set_fillet_field: {
    summary: 'Set one fillet field, e.g. radius.',
    fields: { featureId: str(), field: fieldOf('fillet', 'set_fillet_field'), value: setterValue('fillet') },
  },
  set_chamfer_field: {
    summary: 'Set one chamfer field, e.g. distance.',
    fields: { featureId: str(), field: fieldOf('chamfer', 'set_chamfer_field'), value: setterValue('chamfer') },
  },
  add_fillet_edge: {
    summary: 'Add an edge to fillet.',
    fields: { featureId: str(), edgeQuery: edgeQuery() },
  },
  remove_fillet_edge: {
    summary: 'Remove a fillet edge by index.',
    fields: { featureId: str(), index: num() },
  },
  add_chamfer_edge: {
    summary: 'Add an edge to chamfer.',
    fields: { featureId: str(), edgeQuery: edgeQuery() },
  },
  remove_chamfer_edge: {
    summary: 'Remove a chamfer edge by index.',
    fields: { featureId: str(), index: num() },
  },
  add_shell: {
    summary: 'Add a shell feature, optionally with its removed faces, thickness, direction and join in the same call.',
    note: SHELL_BULK_NOTE + ' ' + SHELL_FACES_NOTE,
    fields: {
      ...featureAddFields(),
      faces: optArr(
        'Face queries from `select` to remove (the openings), or `{selector}` entries the drive resolves; ' +
        'the same array the document stores as shell.faces. ' +
        'May be empty when `source_body` names a body for a closed hollow.',
      ),
      thickness: optScalar('A positive number or an expression string; defaults to 1 when omitted.'),
      direction: optStr('inward or outward; defaults to inward (the same key the document stores as shell.direction).'),
      join: optStr('sharp or arc; defaults to sharp, which the document stores as an absent shell.join key.'),
    },
  },
  set_shell_field: {
    summary: 'Set one shell field, e.g. thickness.',
    note: SHELL_SIGN_NOTE,
    fields: { featureId: str(), field: fieldOf('shell', 'set_shell_field'), value: setterValue('shell') },
  },
  add_shell_face: {
    summary: 'Add a face to remove in a shell.',
    fields: { featureId: str(), faceQuery: faceQuery() },
  },
  remove_shell_face: {
    summary: 'Remove a shell face pick by index.',
    fields: { featureId: str(), index: num() },
  },
  add_move_face: {
    summary: 'Add a move-face feature, then add its faces.',
    fields: featureAddFields(),
  },
  set_move_face_field: {
    summary: 'Set one move-face field.',
    fields: { featureId: str(), field: fieldOf('move-face', 'set_move_face_field'), value: setterValue('move_face') },
  },
  add_move_face_ref: {
    summary: 'Add a face for move-face.',
    fields: { featureId: str(), faceQuery: faceQuery() },
  },
  remove_move_face_ref: {
    summary: 'Remove a move-face pick by index.',
    fields: { featureId: str(), index: num() },
  },
  add_delete_face: {
    summary: 'Add a delete-face feature, optionally naming faces.',
    fields: { ...featureAddFields(), faces: optArr() },
  },
  add_delete_face_ref: {
    summary: 'Add a face to delete.',
    fields: { featureId: str(), faceQuery: faceQuery() },
  },
  remove_delete_face_ref: {
    summary: 'Remove a delete-face pick by index.',
    fields: { featureId: str(), index: num() },
  },
  add_boolean: {
    summary: 'Add a boolean feature, optionally with its operation, target, tools, keep_tools and clearance in the same call.',
    note: BOOLEAN_INLINE_NOTE + ' ' + BOOLEAN_ARRAY_TOOL_NOTE,
    fields: {
      ...featureAddFields(),
      operation: optStr('union | subtract | intersect; defaults to union.'),
      target: optStr('The body the tools fold into, e.g. body_ex1. Required to solve.'),
      tools: optArr('Body ids, or an array feature ref (@<arrayId>) for every body of that array. At least one is required to solve.'),
      keep_tools: optBool(),
      clearance: optScalar('Signed, subtract only: the tool grows (+) or shrinks (-) before the cut; absent means 0.'),
    },
  },
  set_boolean_field: {
    summary: 'Set one boolean field, e.g. operation.',
    note: BOOLEAN_ARRAY_TOOL_NOTE,
    fields: { featureId: str(), field: fieldOf('boolean', 'set_boolean_field'), value: setterValue('boolean') },
  },
  add_boolean_tool: {
    summary: 'Add a tool body to a boolean.',
    note: BOOLEAN_ARRAY_TOOL_NOTE,
    fields: { featureId: str(), tool: bodyQuery() },
  },
  remove_boolean_tool: {
    summary: 'Remove a boolean tool body.',
    fields: { featureId: str(), tool: bodyQuery() },
  },
  add_pattern: {
    summary: 'Add a pattern of a body or one earlier feature, optionally with its count, spacing and axis.',
    note: PATTERN_NOTE + ' ' + CIRCULAR_AXIS_NOTE + ' ' + PATTERN_INLINE_NOTE,
    fields: {
      ...featureAddFields(),
      subject: optStr('body | feature; defaults to body.'),
      source_body: optStr('Body subject: the body to copy, e.g. body_ex2.'),
      operation: optStr('Body subject: add | new; defaults to add.'),
      include_source: optBool(),
      source_feature: optStr('Feature subject: the feature to repeat, e.g. @ex1: an extrude, revolve or sweep with operation add or cut.'),
      target_body: optStr('Feature subject: the body to apply to when the source feature touched more than one.'),
      mode: optStr('linear | rectangular | circular; defaults to linear.'),
      count: optScalar(),
      pitch: optScalar(),
      direction: optPoint(),
      direction_query: optStr('A straight edge or planar face; overrides direction.'),
      invert: optBool(),
      count_x: optScalar(),
      count_y: optScalar(),
      pitch_x: optScalar(),
      pitch_y: optScalar(),
      direction_x: optPoint(),
      direction_x_query: optStr(),
      invert_x: optBool(),
      direction_y: optPoint(),
      direction_y_query: optStr(),
      invert_y: optBool(),
      step_angle: optNullableScalar(),
      axis: optStr('An edge, sketch entity or face ref; overrides the stored origin/direction pair.'),
      axis_origin: optPoint(),
      axis_direction: optPoint(),
      invert_axis: optBool(),
    },
  },
  set_pattern_field: {
    summary: 'Set one pattern field, e.g. count, pitch or axis.',
    note: PATTERN_NOTE,
    fields: { featureId: str(), field: fieldOf('pattern', 'set_pattern_field'), value: setterValue('pattern') },
  },
  add_delete_body: {
    summary: 'Add a delete-body feature, optionally naming bodies.',
    fields: { ...featureAddFields(), bodies: optArr() },
  },
  add_delete_body_ref: {
    summary: 'Add a body to delete.',
    fields: { featureId: str(), bodyQuery: bodyQuery() },
  },
  remove_delete_body_ref: {
    summary: 'Remove a delete-body pick by index.',
    fields: { featureId: str(), index: num() },
  },
  add_hole: {
    summary: 'Add a hole feature, optionally configured in the same call.',
    note: HOLE_FIELD_NOTE,
    fields: holeAddFields(),
  },
  set_hole_field: {
    summary: 'Set one hole field, e.g. diameter or depth.',
    note: HOLE_FIELD_NOTE,
    fields: { featureId: str(), field: fieldOf('hole', 'set_hole_field'), value: setterValue('hole') },
  },
  add_transform: {
    summary: 'Add a transform feature, optionally with its bodies, operation, translation, rotation and scale in the same call.',
    note: TRANSFORM_NOTE,
    fields: {
      ...featureAddFields(),
      bodies: optArr('Body refs to move; the same array the document stores as transform.bodies. May be empty and edited with add_transform_body later.'),
      operation: optStr('new | replace; absent means new.'),
      translation: optPoint(),
      translation_from: optStr('A point ref for the translation start.'),
      translation_to: optStr('A point ref for the translation end.'),
      rotation_angle: optScalar('Degrees; a number or an expression string.'),
      rotation_euler: optPoint(
        'Extrinsic XYZ degrees as three numbers, e.g. [10, 20, 300]: rotate about world X first, then world Y, then world Z. ' +
        'Numbers only, no expressions. Pivots about rotation_axis_origin, or the world origin. ' +
        'Refused together with rotation_axis, rotation_angle or rotation_axis_direction.',
      ),
      rotation_axis_origin: optPoint(),
      rotation_axis_direction: optPoint(),
      rotation_axis: optStr('A feature-level ref such as @<sketchId>/<entityId>, or an edge query from `select`; overrides the origin/direction pair.'),
      scale: optScalar('A uniform scale, number or expression.'),
      scale_center: optPoint(),
      scale_center_from: optStr('A point ref for the scale centre.'),
    },
  },
  set_transform_field: {
    summary: 'Set one transform field.',
    note: TRANSFORM_NOTE,
    fields: { featureId: str(), field: fieldOf('transform', 'set_transform_field'), value: setterValue('transform') },
  },
  add_transform_body: {
    summary: 'Add a body to a transform.',
    fields: { featureId: str(), bodyQuery: bodyQuery() },
  },
  remove_transform_body: {
    summary: 'Remove a transform body by index.',
    fields: { featureId: str(), index: num() },
  },
  rename_part: {
    summary: 'Rename a body.',
    fields: { bodyId: str(), name: str() },
  },
  set_part_color: {
    summary: 'Set a body colour.',
    fields: { bodyId: str(), color: str('A CSS colour string.') },
  },
  set_part_transparency: {
    summary: 'Set a body transparency.',
    fields: { bodyId: str(), transparency: num() },
  },
  set_part_metalness: {
    summary: 'Set a body metalness.',
    fields: { bodyId: str(), metalness: num() },
  },
  set_part_roughness: {
    summary: 'Set a body roughness.',
    fields: { bodyId: str(), roughness: num() },
  },
  set_part_transmission: {
    summary: 'Set a body transmission.',
    fields: { bodyId: str(), transmission: num() },
  },
  add_mirror: {
    summary: 'Add a mirror feature, optionally with its body, plane and merge flags.',
    note: MIRROR_INLINE_NOTE,
    fields: {
      ...featureAddFields(),
      body: optStr('The body to mirror, e.g. body_ex2.'),
      plane: optStr('The mirror plane: @builtin_plane_*, a bare name, @<planeId>, or a face query.'),
      keep_original: optBool(),
      merge: optBool(),
    },
  },
  set_mirror_field: {
    summary: 'Set one mirror field.',
    fields: { featureId: str(), field: fieldOf('mirror', 'set_mirror_field'), value: setterValue('mirror') },
  },
  add_split: {
    summary: 'Add a split feature, optionally with its bodies, plane and kept side.',
    note: SPLIT_NOTE,
    fields: {
      ...featureAddFields(),
      bodies: optArr('Body refs to cut; a feature ref (@<featureId>) means every body that feature made.'),
      plane: optStr('The cutting plane: @builtin_plane_*, Front/Top/Right, @<planeFeatureId>, or a ?...:flatface pick.'),
      keep: optStr('above | below | both; absent means above.'),
    },
  },
  set_split_field: {
    summary: 'Set one split field, e.g. plane or keep.',
    note: SPLIT_NOTE,
    fields: { featureId: str(), field: fieldOf('split', 'set_split_field'), value: setterValue('split') },
  },
  add_split_body: {
    summary: 'Add a body to a split.',
    fields: { featureId: str(), bodyQuery: bodyQuery() },
  },
  remove_split_body: {
    summary: 'Remove a split body by index.',
    fields: { featureId: str(), index: num() },
  },
  add_variable: {
    summary: 'Add a variable feature.',
    note:
      'A variable must precede every feature that names it: an expression naming a variable defined later is refused with ' +
      '"<field>: variable \'<name>\' is defined after this feature (at index N); move it up with reorder_features". ' +
      'N is the index among the solved (non-builtin) features. `insertAt` and reorder_features.toIndex count the seeded ' +
      'plane rows, so the first user slot is usually 4; a smaller N clamps there. ' + VARIABLE_NAME_NOTE,
    fields: {
      ...featureAddFields(),
      insertAt: insertAt(),
    },
  },
  set_variable_field: {
    summary: 'Set one variable field, e.g. expression.',
    note: VARIABLE_NAME_NOTE,
    fields: { featureId: str(), field: fieldOf('variable', 'set_variable_field'), value: setterValue('variable') },
  },
  add_helix: {
    summary: 'Add a helix feature, optionally from a picked reference.',
    note: 'A helix is a reference curve, not a body. The run or measure reply reports the resolved ' +
      'placement under `curves.<id>` as {origin, axis, start, end, radius, pitch, turns, height, hand}, ' +
      'where `axis` is the climb direction (the reference axis, negated by `direction: reverse`). ' +
      '`@<id>/start` and `@<id>/end` stay valid point refs, e.g. the origin of a sweep profile plane. ' +
      'A bare `$<helixId>` is a valid `pathQuery` on a sweep (a thread), see `add_sweep`.',
    fields: {
      ...featureAddFields(),
      reference: optStr(
        'A picked reference the helix rides on: a cylindrical face, a circular or straight edge, or a ' +
        'sketch circle or line (see docs/document.md, helix).',
      ),
    },
  },
  set_helix_field: {
    summary: 'Set one helix field.',
    fields: { featureId: str(), field: fieldOf('helix', 'set_helix_field'), value: setterValue('helix') },
  },
  reorder_features: {
    summary: 'Move a feature to an absolute index in the log, or directly before or after another feature.',
    note: 'Give exactly one of `toIndex`, `before` or `after`. `before: <featureId>` lands the feature directly above ' +
      'that feature and `after` directly below it, with no rows to count; `toIndex` counts the seeded plane rows, so ' +
      'the first user feature usually sits at index 4. A sketch that names a plane defined after it is fixed with ' +
      '`{featureId: <planeId>, before: <sketchId>}`.',
    fields: {
      featureId: str(),
      toIndex: optNum(),
      before: optStr('A feature id; the moved feature lands directly above it.'),
      after: optStr('A feature id; the moved feature lands directly below it.'),
    },
  },
  set_body_visibility: {
    summary: 'Show or hide a body.',
    fields: { bodyId: str(), visible: bool() },
  },
  reorder_pick_field: {
    summary: 'Reorder one pick field of a feature.',
    fields: { featureId: str(), field: str(), fromIndex: num(), toIndex: num() },
  },
  set_feature_suppression: {
    summary: 'Suppress or unsuppress a feature.',
    fields: { featureId: str(), suppressed: bool() },
  },
  set_rollback: {
    summary: 'Park or clear the rollback bar (undo-entry plumbing).',
    hidden: true,
    fields: { position: { type: 'number', required: true, nullable: true } },
  },
  set_length_unit: {
    summary: 'Set the unit the document\'s stored numbers are written in.',
    note: 'Reinterprets the stored numbers; it does not convert them. The STEP/STL export scales an inch document into millimetres. mm is the default and is stored as the absence of the field.',
    fields: { unit: str('"mm" or "inch".') },
  },
  edit_session: {
    summary: 'Undo-only marker naming an edit session.',
    hidden: true,
    fields: { featureId: str(), description: optStr() },
  },
  preview_commit: {
    summary: 'Undo-only label carrier for a preview commit.',
    hidden: true,
    fields: { description: str() },
  },
  remove_dangling_content: {
    summary: 'Remove dangling projected content the solve flagged.',
    hidden: true,
    fields: { features: obj('Per-feature entity and constraint ids to remove. No part-document schema definition: this is solve plumbing.') },
  },
} satisfies { [K in Mutation['type']]: MutationInfo }

export type MutationCatalog = typeof MUTATION_CATALOG

/** A row's common shape; the inferred rows carry their literal field keys. */
export function mutationInfoOf(type: Mutation['type']): MutationInfo {
  const info = Object.hasOwn(MUTATION_CATALOG, type)
    ? (MUTATION_CATALOG as Record<Mutation['type'], MutationInfo>)[type]
    : undefined
  if (info === undefined) throw new Error(`no mutation catalog row for type "${type}"`)
  return info
}

// Hidden means the app produces the mutation and an external script must not.
export const HIDDEN_MUTATION_TYPES: ReadonlySet<Mutation['type']> = new Set(
  (Object.entries(MUTATION_CATALOG) as Array<[Mutation['type'], MutationInfo]>)
    .filter(([, info]) => info.hidden === true)
    .map(([type]) => type),
)

export const MUTATION_FAMILY: Record<Mutation['type'], MutationFamily> = {
  move_vertex: 'sketch',
  move_vertex_with_constraint: 'sketch',
  move_entity: 'sketch',
  resize_circle: 'sketch',
  add_constraint: 'sketch',
  set_constraint_value: 'sketch',
  set_constraint_pos: 'sketch',
  set_constraint_sign: 'sketch',
  delete: 'sketch',
  add_entity: 'sketch',
  add_entity_with_constraint: 'sketch',
  import_dxf: 'sketch',
  add_text: 'sketch',
  insert_fit_point: 'sketch',
  set_fit_spline_handle: 'sketch',
  add_projected_entity: 'sketch',
  add_rect: 'sketch',
  add_center_rect: 'sketch',
  add_ngon: 'sketch',
  add_three_point_arc: 'sketch',
  apply_offset: 'sketch',
  mirror_entities: 'sketch',
  fillet_corners: 'sketch',
  pattern_entities: 'sketch',
  toggle_construction: 'sketch',
  set_feature_plane: 'sketch',
  add_sketch: 'sketch',
  toggle_sketch_plane_visibility: 'sketch',
  delete_feature: 'document',
  set_feature_visibility: 'document',
  add_plane: 'features',
  set_plane_definition_field: 'features',
  toggle_plane_visibility: 'features',
  rename_feature: 'document',
  add_extrude: 'features',
  set_extrude_field: 'features',
  add_extrude_profile: 'features',
  remove_extrude_profile: 'features',
  add_revolve: 'features',
  set_revolve_field: 'features',
  add_revolve_profile: 'features',
  remove_revolve_profile: 'features',
  add_sweep: 'features',
  set_sweep_field: 'features',
  add_sweep_profile: 'features',
  remove_sweep_profile: 'features',
  add_sweep_path: 'features',
  remove_sweep_path: 'features',
  add_import_step: 'features',
  add_fillet: 'features',
  add_chamfer: 'features',
  set_fillet_field: 'features',
  set_chamfer_field: 'features',
  add_fillet_edge: 'picks',
  remove_fillet_edge: 'picks',
  add_chamfer_edge: 'picks',
  remove_chamfer_edge: 'picks',
  add_shell: 'features',
  set_shell_field: 'features',
  add_shell_face: 'picks',
  remove_shell_face: 'picks',
  add_move_face: 'features',
  set_move_face_field: 'features',
  add_move_face_ref: 'picks',
  remove_move_face_ref: 'picks',
  add_delete_face: 'features',
  add_delete_face_ref: 'picks',
  remove_delete_face_ref: 'picks',
  add_boolean: 'features',
  set_boolean_field: 'features',
  add_boolean_tool: 'picks',
  remove_boolean_tool: 'picks',
  add_pattern: 'features',
  set_pattern_field: 'features',
  add_delete_body: 'features',
  add_delete_body_ref: 'picks',
  remove_delete_body_ref: 'picks',
  add_hole: 'features',
  set_hole_field: 'features',
  add_transform: 'features',
  set_transform_field: 'features',
  add_transform_body: 'picks',
  remove_transform_body: 'picks',
  rename_part: 'part style',
  set_part_color: 'part style',
  set_part_transparency: 'part style',
  set_part_metalness: 'part style',
  set_part_roughness: 'part style',
  set_part_transmission: 'part style',
  add_mirror: 'features',
  set_mirror_field: 'features',
  add_split: 'features',
  set_split_field: 'features',
  add_split_body: 'picks',
  remove_split_body: 'picks',
  add_variable: 'features',
  set_variable_field: 'features',
  add_helix: 'features',
  set_helix_field: 'features',
  reorder_features: 'document',
  set_body_visibility: 'part style',
  reorder_pick_field: 'picks',
  set_feature_suppression: 'document',
  set_rollback: 'document',
  set_length_unit: 'document',
  edit_session: 'document',
  preview_commit: 'document',
  remove_dangling_content: 'document',
}

export type MutationValidationErrorCode = 'unknown-mutation' | 'invalid-mutation' | 'internal-mutation' | 'unknown-target'

export type MutationValidation =
  | { ok: true; mutation: Mutation }
  | { ok: false; error: { code: MutationValidationErrorCode; message: string } }

export interface MutationValidationOptions {
  // Journal replay reapplies mutations the app itself produced, so internal
  // plumbing (insertAt, drag snapshots, hidden gesture types) is legitimate
  // there. External scripts keep the strict default.
  allowInternal?: boolean
  // The document the step will be applied to. Supplying it lets the value rules
  // also refuse a target that names nothing and a duplicate entity id; without
  // it only the value's shape is checked.
  doc?: PartDoc | null
  // The file ids the run's `files` map carries, so an import_dxf naming a file
  // nobody supplied can be refused before the step runs. Null or absent skips
  // the check and refuses the `file` spelling by name: the browser bridge has
  // no files map to resolve it against.
  fileIds?: ReadonlySet<string> | null
}

function fail(code: MutationValidationErrorCode, message: string): MutationValidation {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Levenshtein, capped at 2 edits by the callers: enough for the typo these
// boundaries exist for (add_fillett, cs_diameter) and far too little to guess at
// noise.
function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return previous[b.length]
}

// Capped edit distance over a name vocabulary: the mutation-type hint and the
// field-name hint (Ex019) read the same rule, one for the row, one for the row's
// fields. Internal fields are filtered out by the caller: the boundary would
// refuse what it suggests.
function nearestName(candidates: readonly string[], key: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function nearestMutationType(type: string): string | null {
  return nearestName(Object.keys(MUTATION_CATALOG), type)
}

// `cs_diameter` is one edit from `cb_diameter` (Ex019: the `cb_`/`cs_` prefix
// pair makes it the first guess for a countersink mouth), so the refusal names
// the field the guess meant and one call fixes it. Nothing within the cap is
// invented for a key that is simply not a field.
function fieldHint(fields: Record<string, FieldInfo>, key: string): string {
  const candidates = Object.keys(fields).filter(name => fields[name].internal !== true)
  const suggestion = nearestName(candidates, key)
  return suggestion === null ? '' : `; did you mean "${suggestion}"?`
}

function matchesType(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'query':
      return typeof value === 'string'
    case 'queryOrSelector':
      return typeof value === 'string'
        || (isRecord(value) && Object.keys(value).length === 1 && isRecord(value.selector))
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'point':
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
    case 'scalar':
      return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    case 'any':
      return true
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * The target-list sketch mutations that take no `featureId`. A caller that
 * sends one is taught the shape the row holds rather than only that the key is
 * unknown: the document and journals already carry this shape, so this is
 * guidance, not an alias.
 */
const TARGET_LIST_SHAPE: Partial<Record<Mutation['type'], string>> = {
  toggle_construction: 'targets: ["entity:<sketchId>:<entityId>"]',
  delete: 'targets: ["entity:<sketchId>:<entityId>", '
    + '"vertex:<sketchId>:<entityId>:<vertexKey>" or "constraint:<sketchId>:<constraintId>"]',
}

/**
 * Refuse an untyped mutation at the drive boundary. A non-object, a missing
 * type, an unknown type, a hidden type and a wrong or missing field all come
 * back as a named Result, so the script runner records one failing step
 * instead of applying nothing.
 */
export function validateMutation(raw: unknown, options: MutationValidationOptions = {}): MutationValidation {
  if (!isRecord(raw)) return fail('invalid-mutation', 'a mutation must be an object')
  const type = raw.type
  if (typeof type !== 'string' || type.length === 0) {
    return fail('invalid-mutation', 'a mutation needs a non-empty string "type"')
  }
  const catalog = MUTATION_CATALOG as Record<string, MutationInfo | undefined>
  const info = Object.hasOwn(catalog, type) ? catalog[type] : undefined
  if (!info) {
    const suggestion = nearestMutationType(type)
    const hint = suggestion === null ? '' : `; did you mean "${suggestion}"?`
    return fail('unknown-mutation', `unknown mutation type "${type}"${hint}`)
  }
  if (info.hidden === true && options.allowInternal !== true) {
    return fail('internal-mutation', `mutation type "${type}" is internal and cannot be sent by a script`)
  }
  // A key the row does not declare is refused even on the replay path: only
  // fields a mutation actually carries may ride on it, so insertAt cannot be
  // smuggled onto a visible non-add row to move the rollback bar. The refusal
  // names the near miss (Ex019): a spelling the boundary does not take is a
  // hint, never a silent alias, so the document keeps one spelling per meaning.
  for (const key of Object.keys(raw)) {
    if (key === 'type') continue
    if (!Object.hasOwn(info.fields, key)) {
      if (key === 'featureId') {
        const shape = TARGET_LIST_SHAPE[type as Mutation['type']]
        if (shape !== undefined) {
          return fail('invalid-mutation', `${type} takes ${shape}`)
        }
      }
      return fail('invalid-mutation', `mutation type "${type}" has no field "${key}"${fieldHint(info.fields, key)}`)
    }
  }
  for (const [name, fieldInfo] of Object.entries(info.fields)) {
    const value = raw[name]
    if (value === undefined) {
      if (fieldInfo.required) {
        return fail('invalid-mutation', `mutation type "${type}" is missing required field "${name}"`)
      }
      continue
    }
    // Internal plumbing is refused by field, not only by mutation type: a
    // script must not smuggle insertAt or a drag snapshot into a visible row.
    if (fieldInfo.internal === true && options.allowInternal !== true) {
      return fail(
        'internal-mutation',
        `mutation type "${type}" field "${name}" is internal and cannot be sent by a script`,
      )
    }
    // Null is accepted only where the union says `| null`; an optional field
    // is not implicitly nullable and `any` does not swallow null either.
    if (value === null) {
      if (fieldInfo.nullable === true) continue
      return fail('invalid-mutation', `mutation type "${type}" field "${name}" must be ${fieldInfo.type}, got null`)
    }
    if (!matchesType(fieldInfo.type, value)) {
      return fail(
        'invalid-mutation',
        `mutation type "${type}" field "${name}" must be ${fieldInfo.type}, got ${typeName(value)}`,
      )
    }
  }
  // A setter names one field of its kind's schema sub-definition. Refuse an
  // unknown name here, where a script first meets the boundary, rather than
  // letting the applier store a key the published schema then rejects. The
  // check is skipped on the replay path: replay reapplies mutations the app
  // itself produced, so an app-issued setter outside the schema (none today)
  // must still record and replay rather than fail only on the way back in.
  if (options.allowInternal !== true) {
    const setterFields = setterFieldNames(type as Mutation['type'])
    if (setterFields !== null && typeof raw.field === 'string' && !setterFields.includes(raw.field)) {
      // The row note carries guidance a field list cannot, so a wrong hole
      // field teaches what the sketch must name instead of only listing names.
      const note = info.note === undefined ? '' : ` ${info.note}`
      const suggestion = nearestName(setterFields, raw.field)
      const hint = suggestion === null ? '' : `; did you mean "${suggestion}"?`
      return fail(
        'invalid-mutation',
        `mutation type "${type}" has no field "${raw.field}"${hint}; valid fields: ${setterFields.join(', ')}.${note}`,
      )
    }
    // Value rules run on the same external path: the field names and JSON types
    // are right, but the value may still be one the field (or the document)
    // cannot hold. A row is 'none' where the applier owns every value it admits.
    const violation = mutationValueViolation(type as Mutation['type'], raw, {
      doc: options.doc ?? null,
      fileIds: options.fileIds ?? null,
      fieldSchema: setterFieldSchema,
      fieldRequired: setterFieldRequired,
    })
    if (violation !== null) return fail(violation.code, violation.message)
  }
  return { ok: true, mutation: raw as Mutation }
}
