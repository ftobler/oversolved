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
import { mutationValueViolation } from '@/drive/mutationValues'

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'point'
  | 'array'
  | 'object'
  | 'query'
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
const nullableStr = () => ({ type: 'string', required: false, nullable: true } as const)
const num = (note?: string) => ({ type: 'number', required: true, ...(note !== undefined && { note }) } as const)
const optNum = () => ({ type: 'number', required: false } as const)
const optObj = () => ({ type: 'object', required: false } as const)
const bool = () => ({ type: 'boolean', required: true } as const)
const point = (note?: string) => ({ type: 'point', required: true, ...(note !== undefined && { note }) } as const)
const optPoint = () => ({ type: 'point', required: false } as const)
const arr = (note?: string) => ({ type: 'array', required: true, ...(note !== undefined && { note }) } as const)
const optArr = (note?: string) => ({ type: 'array', required: false, ...(note !== undefined && { note }) } as const)
const obj = (note?: string) => ({ type: 'object', required: true, ...(note !== undefined && { note }) } as const)
const shapedObj = (shape: JsonSchema, note?: string) =>
  ({ type: 'object', required: false, shape, ...(note !== undefined && { note }) } as const)
const query = (note: string) => ({ type: 'query', required: true, note } as const)
const optQuery = (note: string) => ({ type: 'query', required: false, note } as const)
// The pass-through setter value: null is the documented clear (a deleted
// field), so it is nullable even though the applier owns the real type.
const anyValue = (note?: string) =>
  ({ type: 'any', required: true, nullable: true, ...(note !== undefined && { note }) } as const)
// A number-or-expression field a bulk add can carry in its own payload.
const optScalar = (note?: string) =>
  ({ type: 'scalar', required: false, ...(note !== undefined && { note }) } as const)

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

const sketchQuery = () => query('$<sketchId>: the sketch feature to consume.')
const edgeQuery = () => query('An edge query as returned by `select`.')
const faceQuery = () => query('A face query as returned by `select`.')
const bodyQuery = () => query('A body id such as body_ex1, or a stored body query.')

// A sketch plane resolves through the query repository, so a face query from
// `select` is accepted beside the plane feature ref and the bare name.
const PLANE_QUERY_NOTE =
  '@<planeId>, a bare plane name (Top, Front, Right), or a face query from `select` '
  + '(the stored ?...:flatface string): a face query places the sketch on that face.'

// The params slot order per entity kind, generated from the entity registry so
// a new kind or a moved slot cannot leave the catalog stale.
const ENTITY_PARAMS_NOTE =
  `Params per kind, in order: ${entityParamLayoutsSentence()}. ` +
  'Arc and ellipse angles are degrees; an arc sweeps counter-clockwise from a0_deg to a1_deg.'

// The constraint operand grammar an author writes by hand. A sketch-local
// `$<entityId>` is accepted and is what the app stores; the explicit forms name
// the sketch too, so a script can be written without knowing the local ids.
const VERTEX_REF_NOTE =
  'A constraint target may be a sketch-local ref ($<entityId>, as the app stores it) or an explicit ref '
  + 'entity:<sketchId>:<entityId> / vertex:<sketchId>:<entityId>:<key>, where key is start/end on a line, '
  + 'center on a circle or arc, and xy on a point. Builtin refs such as @builtin_origin are also accepted.'

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
  set_array_field: 'array',
  set_circular_array_field: 'circular_array',
  set_hole_field: 'hole',
  set_transform_field: 'transform',
  set_mirror_field: 'mirror',
  set_variable_field: 'variable',
  set_helix_field: 'helix',
} as const satisfies Record<FieldSetterType, FeatureKind>

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

// The value-rule table is part of the boundary's contract, so it is published
// next to the catalog: a test (and a future docs page) reads one name for it.
export { MUTATION_VALUE_RULES } from '@/drive/mutationValues'
export type { ValueRule, ValueViolation, ValueViolationCode } from '@/drive/mutationValues'

const HOLE_FIELD_NOTE =
  `Canonical hole fields: ${featureFieldNames('hole').join(', ')}. ` +
  'The required fields are sketch, diameter, depth_mode, depth; the optional ones are direction, target, thread. ' +
  '`depth_mode` is blind or through_all. `sketch` is a feature-level ref, so spell it ' +
  '@<sketchId> (or a narrower entity:/vertex:/? pick from the viewport), not the profile consumers\' ' +
  '$<sketchId> form; a $ ref is refused here. ' +
  'The sketch\'s points and circles are drilled: a circle at its own radius, a point at the feature `diameter`. ' +
  'A single point or circle picked alone drills only that one. ' +
  '`style` widens the mouth: `counterbore` reads `cb_diameter` and `cb_depth`, `countersink` reads `cb_diameter` and `cs_angle` (degrees, default 90); absent means `simple`. ' +
  'An empty value clears any other field (the key is deleted), but `sketch` is stored verbatim, so send a sketch id rather than "".'

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
    target: optStr('The body to drill into; the first body when absent.'),
    style: optStr('simple | counterbore | countersink (absent means simple).'),
    cb_diameter: optScalar(),
    cb_depth: optScalar(),
    cs_angle: optScalar(),
    thread: thread === undefined ? optObj() : shapedObj(thread, 'The cosmetic thread spec: designation, nominal and pitch.'),
  }
}

// The transform's axis trio is the one place an author has to choose a
// spelling; the solver composes exactly one axis for the whole feature.
const TRANSFORM_NOTE =
  'One transform applies translation, then rotation, then scale about a single axis, equally to every body in `bodies`. ' +
  'For the rotation, name either `rotation_axis` (a feature-level ref such as @<sketchId>/<entityId>, or an edge query from `select`) ' +
  'or the stored pair `rotation_axis_origin` (VEC3 point) and `rotation_axis_direction` (VEC3, non-zero). ' +
  'A resolved `rotation_axis` derives both from that edge and overrides the pair; `rotation_axis_direction` alone rotates about the world origin, ' +
  'and `rotation_axis_origin` alone uses +Z. `translation_from`/`translation_to` and `scale_center_from` are point refs. ' +
  '`rotation_angle` is degrees; `operation: new` keeps the source and emits a new body, `replace` consumes it.'

// The revolve axis resolves through the feature-level query repository, not the
// sketch-local `$` namespace: @sk/entity and edge queries work, `$sk` does not.
const REVOLVE_AXIS_NOTE =
  '`axis` is a feature-level ref, not the profile\'s sketch-local $ form: name a sketch entity as ' +
  '@<sketchId>/<entityId> (a line, or a circle/arc whose center sits on the axis), or an edge query from `select`. ' +
  'A $<sketchId> ref does not resolve in `axis`.'

// Plane refs are exact on purpose: a case-insensitive bare-name match could
// shadow a user plane whose id differs only by case. The boundary refuses an
// unmatched ref with this list rather than letting the resolver fall back to XY.
const PLANE_REF_NOTE =
  '`plane` is "@builtin_plane_front", "@builtin_plane_top", "@builtin_plane_right", ' +
  'a bare builtin name (Front, Top, Right; case-sensitive), "@<planeId>" for a plane feature, ' +
  'or a "?" face query from `select`. An unmatched name is refused with the valid names; ' +
  'it never silently falls back to the XY plane.'

// The array's "add" is a union only where the copies touch. Disjoint instances
// stay separate B-reps and therefore separate bodies, with the source id plus
// sibling suffixes. Name that here so the operation word does not read as a fuse
// of the instances into one body when the geometry does not connect them.
const ARRAY_OPERATION_NOTE =
  '`operation: add` unions each instance into the source body when they intersect; disjoint copies split into ' +
  'separate bodies, taking the source id and `_1`, `_2`... siblings (the `run` reply summary names the live ids). ' +
  '`operation: new` keeps the source as instance 0 and mints one body per copy.'

const FILLET_BULK_NOTE =
  'One call may carry the whole pick: `edges` appends the query strings `select` returned, and `radius` sets the ' +
  'radius in the same step. `add_fillet_edge` and `set_fillet_field` remain for later single-edge and field edits.'

const fieldOf = (label: string, type: FieldSetterType) =>
  str(`The ${label} field to set. Valid fields: ${(setterFieldNames(type) ?? []).join(', ')}.`)
// A setter value's real type is the named schema field's; name that definition
// instead of trying to restate every feature field's union here. The enum
// members are generated from the schema, so a renamed value cannot go stale.
const setterValue = (kind: FeatureKind) =>
  anyValue(
    `The new value for the named field; its type follows FEATURE_SCHEMA_BY_KIND.${kind} in persistence/partDocSchema.ts.`
    + enumFieldsNote(kind)
    + ' A null, undefined or empty-string value clears the field (the key is deleted), except hole.sketch, which is stored verbatim.',
  )
const planeDefinitionValue = () =>
  ({
    type: 'scalar',
    required: true,
    note: 'The new value for the named plane definition field; its type follows PLANE_DEF in persistence/partDocSchema.ts.'
      + enumFieldsNote('plane')
      + ' A null or empty-string value clears the field.',
  } as const)

/** The enum-valued fields of a feature kind, as `name: a|b|c`, read from the
 *  kind's schema so the note follows the union rather than a second list. */
function enumFieldsNote(kind: FeatureKind): string {
  const params = featureParamsSchema(kind)
  if (params === null) return ''
  const entries: string[] = []
  for (const [name, property] of Object.entries(params.properties as Record<string, JsonSchema>)) {
    if (Array.isArray(property.enum)) entries.push(`${name}: ${property.enum.join('|')}`)
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
      kind: str('The constraint kind, e.g. coincident or distance.'),
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
    summary: 'Delete sketch entities, constraints or features by id.',
    fields: { targets: arr('Ids to delete across the document.') },
  },
  add_entity: {
    summary: 'Add one sketch entity of a kind with numeric params.',
    fields: {
      featureId: str(),
      kind: str('Entity kind: line, circle, arc, ellipse, spline or point.'),
      params: arr(ENTITY_PARAMS_NOTE),
      entityId: optStr(),
    },
  },
  add_entity_with_constraint: {
    summary: 'Add a sketch entity and pin one of its vertices to a snap target.',
    note: '`vertexKey` names the new entity vertex the snap constraint attaches: start/end on a line, center on a circle or arc, xy on a point.',
    fields: {
      featureId: str(),
      kind: str('Entity kind: line, circle, arc, ellipse, spline or point.'),
      params: arr(ENTITY_PARAMS_NOTE),
      vertexKey: str(),
      snapVertexId: optStr(),
      snapEntityRef: optStr(),
      constraintKind: str(),
      entityId: optStr(),
    },
  },
  add_projected_entity: {
    summary: 'Project a body edge into a sketch as an entity.',
    fields: { featureId: str(), kind: str(), source: str('The source edge ref.'), entityId: optStr() },
  },
  add_rect: {
    summary: 'Add an axis-aligned rectangle with its lines and constraints.',
    fields: {
      featureId: str(),
      p0: point(),
      p1: point(),
      p0Ref: nullableStr(),
      p1Ref: nullableStr(),
    },
  },
  add_center_rect: {
    summary: 'Add a rectangle by centre and corner.',
    note: '`corner` is the half-diagonal corner: the rectangle mirrors it through `center`, so '
      + 'center [0,0] with corner [1,1] gives a 2x2 rectangle. The feature also leaves a centre point entity '
      + '(not construction geometry) that the two diagonal midpoint constraints reference; delete it if it is not wanted.',
    fields: {
      featureId: str(),
      center: point(),
      corner: point(),
      centerRef: nullableStr(),
      cornerRef: nullableStr(),
    },
  },
  add_ngon: {
    summary: 'Add a regular polygon by centre, corner and side count.',
    fields: {
      featureId: str(),
      center: point(),
      corner: point(),
      sides: num(),
      centerRef: nullableStr(),
      cornerRef: nullableStr(),
    },
  },
  apply_offset: {
    summary: 'Offset sketch entities by a distance. Each sourceId must name an entity in the featureId sketch; '
      + 'a connected chain (coincident or coordinate-joined) is refitted corner to corner.',
    fields: { featureId: str(), sourceIds: arr(), distance: num() },
  },
  toggle_construction: {
    summary: 'Toggle construction mode on sketch entities.',
    fields: { targets: arr() },
  },
  set_feature_plane: {
    summary: 'Move a sketch to another plane.',
    note: PLANE_REF_NOTE,
    fields: { featureId: str(), plane: query(PLANE_QUERY_NOTE) },
  },
  add_sketch: {
    summary: 'Add a sketch feature, optionally on a plane.',
    note: PLANE_REF_NOTE,
    fields: {
      featureId: str(),
      label: optStr(),
      plane: optQuery(PLANE_QUERY_NOTE),
      insertAt: insertAt(),
    },
  },
  delete_feature: {
    summary: 'Delete a feature and everything downstream of it.',
    fields: { featureId: str() },
  },
  set_feature_visibility: {
    summary: 'Show or hide a feature.',
    fields: { featureId: str(), visible: bool() },
  },
  add_plane: {
    summary: 'Add a construction plane feature.',
    fields: {
      ...featureAddFields(),
      definition: shapedObj(planeDefinitionSchema(), 'The plane definition object; the schema lists its modes and fields.'),
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
    summary: 'Extrude a sketch along its plane normal.',
    fields: { ...featureAddFields(), sketchQuery: sketchQuery(), distance: num() },
  },
  set_extrude_field: {
    summary: 'Set one extrude field (distance, direction, operation, ...).',
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
    summary: 'Revolve a sketch around its plane axis.',
    note: REVOLVE_AXIS_NOTE,
    fields: { ...featureAddFields(), sketchQuery: sketchQuery(), angle: num() },
  },
  set_revolve_field: {
    summary: 'Set one revolve field.',
    note: REVOLVE_AXIS_NOTE,
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
    summary: 'Sweep a profile sketch along a path sketch.',
    fields: {
      ...featureAddFields(),
      sketchQuery: sketchQuery(),
      pathQuery: query('$<sketchId>: the path sketch.'),
    },
  },
  set_sweep_field: {
    summary: 'Set one sweep field.',
    fields: { featureId: str(), field: fieldOf('sweep', 'set_sweep_field'), value: setterValue('sweep') },
  },
  add_sweep_profile: {
    summary: 'Add a profile sketch to a sweep.',
    fields: { featureId: str(), sketchQuery: sketchQuery() },
  },
  remove_sweep_profile: {
    summary: 'Remove a sweep profile by index.',
    fields: { featureId: str(), index: num() },
  },
  add_sweep_path: {
    summary: 'Add a path sketch to a sweep.',
    fields: { featureId: str(), pathQuery: query('$<sketchId>: the path sketch.') },
  },
  remove_sweep_path: {
    summary: 'Remove a sweep path by index.',
    fields: { featureId: str(), index: num() },
  },
  add_import_step: {
    summary: 'Import a STEP file as a feature.',
    fields: { ...featureAddFields(), fileId: str('The files entry id carrying the bytes.') },
  },
  add_fillet: {
    summary: 'Add a fillet feature, optionally with its edges and radius in the same call.',
    note: FILLET_BULK_NOTE,
    fields: {
      ...featureAddFields(),
      edges: optArr('Edge queries from `select`; the same array the document stores as fillet.edges.'),
      radius: optScalar('A positive number or an expression string; defaults to 1 when omitted.'),
    },
  },
  add_chamfer: {
    summary: 'Add a chamfer feature, then add its edges.',
    fields: featureAddFields(),
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
    summary: 'Add a shell feature, then add its removed faces.',
    fields: featureAddFields(),
  },
  set_shell_field: {
    summary: 'Set one shell field, e.g. thickness.',
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
    summary: 'Add a boolean feature, then add its tool bodies.',
    fields: featureAddFields(),
  },
  set_boolean_field: {
    summary: 'Set one boolean field, e.g. operation.',
    fields: { featureId: str(), field: fieldOf('boolean', 'set_boolean_field'), value: setterValue('boolean') },
  },
  add_boolean_tool: {
    summary: 'Add a tool body to a boolean.',
    fields: { featureId: str(), tool: bodyQuery() },
  },
  remove_boolean_tool: {
    summary: 'Remove a boolean tool body.',
    fields: { featureId: str(), tool: bodyQuery() },
  },
  add_array: {
    summary: 'Add a linear array feature.',
    note: ARRAY_OPERATION_NOTE,
    fields: featureAddFields(),
  },
  set_array_field: {
    summary: 'Set one linear-array field.',
    note: ARRAY_OPERATION_NOTE,
    fields: { featureId: str(), field: fieldOf('array', 'set_array_field'), value: setterValue('array') },
  },
  add_circular_array: {
    summary: 'Add a circular array feature.',
    note: ARRAY_OPERATION_NOTE,
    fields: featureAddFields(),
  },
  set_circular_array_field: {
    summary: 'Set one circular-array field.',
    note: ARRAY_OPERATION_NOTE,
    fields: { featureId: str(), field: fieldOf('circular array', 'set_circular_array_field'), value: setterValue('circular_array') },
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
    summary: 'Add a transform feature, then add its bodies.',
    note: TRANSFORM_NOTE,
    fields: featureAddFields(),
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
    summary: 'Add a mirror feature.',
    fields: featureAddFields(),
  },
  set_mirror_field: {
    summary: 'Set one mirror field.',
    fields: { featureId: str(), field: fieldOf('mirror', 'set_mirror_field'), value: setterValue('mirror') },
  },
  add_variable: {
    summary: 'Add a variable feature.',
    fields: featureAddFields(),
  },
  set_variable_field: {
    summary: 'Set one variable field, e.g. expression.',
    fields: { featureId: str(), field: fieldOf('variable', 'set_variable_field'), value: setterValue('variable') },
  },
  add_helix: {
    summary: 'Add a helix feature, optionally from a picked reference.',
    fields: {
      ...featureAddFields(),
      reference: optStr('A picked reference the helix rides on.'),
    },
  },
  set_helix_field: {
    summary: 'Set one helix field.',
    fields: { featureId: str(), field: fieldOf('helix', 'set_helix_field'), value: setterValue('helix') },
  },
  reorder_features: {
    summary: 'Move a feature to an absolute index in the log.',
    fields: { featureId: str(), toIndex: num() },
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
  add_projected_entity: 'sketch',
  add_rect: 'sketch',
  add_center_rect: 'sketch',
  add_ngon: 'sketch',
  apply_offset: 'sketch',
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
  add_array: 'features',
  set_array_field: 'features',
  add_circular_array: 'features',
  set_circular_array_field: 'features',
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
  add_variable: 'features',
  set_variable_field: 'features',
  add_helix: 'features',
  set_helix_field: 'features',
  reorder_features: 'document',
  set_body_visibility: 'part style',
  reorder_pick_field: 'picks',
  set_feature_suppression: 'document',
  set_rollback: 'document',
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
}

function fail(code: MutationValidationErrorCode, message: string): MutationValidation {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Levenshtein over the catalog keys, capped at 2 edits: enough for the typo
// this boundary exists for (add_fillett) and far too little to guess at noise.
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

export function nearestMutationType(type: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of Object.keys(MUTATION_CATALOG)) {
    const distance = editDistance(type, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function matchesType(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'query':
      return typeof value === 'string'
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
  // smuggled onto a visible non-add row to move the rollback bar.
  for (const key of Object.keys(raw)) {
    if (key === 'type') continue
    if (!Object.hasOwn(info.fields, key)) {
      return fail('invalid-mutation', `mutation type "${type}" has no field "${key}"`)
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
      return fail(
        'invalid-mutation',
        `mutation type "${type}" has no field "${raw.field}"; valid fields: ${setterFields.join(', ')}.${note}`,
      )
    }
    // Value rules run on the same external path: the field names and JSON types
    // are right, but the value may still be one the field (or the document)
    // cannot hold. A row is 'none' where the applier owns every value it admits.
    const violation = mutationValueViolation(type as Mutation['type'], raw, {
      doc: options.doc ?? null,
      fieldSchema: setterFieldSchema,
    })
    if (violation !== null) return fail(violation.code, violation.message)
  }
  return { ok: true, mutation: raw as Mutation }
}
