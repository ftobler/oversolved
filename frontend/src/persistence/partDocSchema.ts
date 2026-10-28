// The part-document JSON Schema: the machine-readable contract an agent (or a
// translator, or the fuzzer) reads instead of inferring the format from
// examples. It is served as an MCP resource (drive/mcpServer.ts) and checked
// against the shipped types and the oracle corpus by
// persistence/__tests__/docRefCanon.schema.test.ts.
//
// The schema pins the two canonical spellings this feature chose: params live
// under the kind key (a flat param fails `additionalProperties: false`), and a
// feature-level reference to a feature never starts with `$` (the ref pattern
// below). `$` stays host-local to a sketch's own constraint operands, which live
// outside the ref fields and are not pattern-checked.
//
// The per-kind table is keyed by `FeatureKind` (via `satisfies`), so a new
// feature variant fails to type-check until its schema lands here. A hand-written
// schema is allowed only because that compile-time tether and the corpus test
// keep it from drifting from types/cad.ts.

import type { FeatureKind } from '@/types/cad'

export type JsonSchema = Record<string, unknown>

/** A feature-level reference to a feature, a body or a query. It never starts
 *  with `$`: `$` is host-local to the owning sketch's entities, not a
 *  feature-to-feature ref. The negative lookahead accepts `@`, `?`, `entity:`
 *  and `vertex:` forms. */
const REF: JsonSchema = { type: 'string', pattern: '^(?!\\$)' }
const REF_LIST: JsonSchema = { type: 'array', items: REF }
const REF_OR_LIST: JsonSchema = { anyOf: [REF, REF_LIST] }
// The description is what a schema reader sees beside every expression field:
// an expression names a variable by its label, which the flange run guessed.
const NUMBER_OR_EXPR: JsonSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }],
  description: 'A number, or an expression string; an expression names a variable by the variable feature\'s `label`, not its id.',
}
const VEC3: JsonSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

const BASE_PROPERTIES: JsonSchema = {
  id: { type: 'string', minLength: 1 },
  label: { type: 'string' },
  visible: { type: 'boolean' },
  suppressed: { type: 'boolean' },
}

interface SubDef {
  // The kind's param container; null for a kind whose params stay feature-level
  // (sketch's entities/initial/constraints, import_step's file_id/scale, origin).
  key: string | null
  properties: JsonSchema
  required?: string[]
  // Conditional requirements inside the param container, for a field whose
  // necessity depends on another field (hole.depth is required only when
  // depth_mode is blind).
  allOf?: JsonSchema[]
}

// The param-container key each kind registered with feature(), so callers can
// read a kind's field shape back out of FEATURE_SCHEMA_BY_KIND without guessing
// it from property names.
const FEATURE_PARAM_KEY = new Map<FeatureKind, string | null>()

function feature(kind: FeatureKind, sub: SubDef): JsonSchema {
  FEATURE_PARAM_KEY.set(kind, sub.key)
  const properties: JsonSchema = { ...BASE_PROPERTIES, kind: { const: kind } }
  const required = ['id', 'kind']
  if (sub.key === null) {
    Object.assign(properties, sub.properties)
    required.push(...(sub.required ?? []))
  } else {
    properties[sub.key] = {
      type: 'object',
      properties: sub.properties,
      required: sub.required ?? [],
      ...(sub.allOf !== undefined && { allOf: sub.allOf }),
      additionalProperties: false,
    }
    required.push(sub.key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const ENTITY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { type: 'string' },
    construction: { type: 'boolean' },
    source: { type: 'string' },
    // Fit splines only: which end handles the entity stores. The params carry
    // the handle points themselves (D2), so the field is a layout selector.
    handles: { enum: ['start', 'end', 'both'] },
  },
  additionalProperties: false,
}

// A constraint operand may be a wire string (`$entityId`, `@builtin_origin`), a
// resolved dict (`{entity, point}`), or an `{external_xy}` origin. The wire
// spellings here are host-local by construction, so the schema leaves the
// operand payload open rather than repeating the whole operand grammar.
const CONSTRAINT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string', minLength: 1 },
    kind: { type: 'string' },
  },
  additionalProperties: true,
}

const PLANE_DEF: JsonSchema = {
  type: 'object',
  properties: {
    mode: { enum: ['offset', 'three_point', 'plane_point', 'line_angle', 'edge_point', 'on_face', 'on_face_edge_angle'] },
    plane: REF,
    offset: NUMBER_OR_EXPR,
    p1: REF,
    p2: REF,
    p3: REF,
    point: REF,
    line: REF,
    edge: REF,
    face: REF,
    angle: NUMBER_OR_EXPR,
    rotation: NUMBER_OR_EXPR,
  },
  additionalProperties: false,
}

const SKETCH_SCHEMA = feature('sketch', {
  key: null,
  properties: {
    plane: REF,
    entities: { type: 'array', items: ENTITY_SCHEMA },
    initial: { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' } } },
    constraints: { type: 'array', items: CONSTRAINT_SCHEMA },
    auto_hidden: { type: 'boolean' },
    drag_anchor: REF,
  },
})

// The per-kind feature schemas, keyed by FeatureKind so the union and the schema
// cannot drift. `origin` has no params; `plane` uses `definition`.
export const FEATURE_SCHEMA_BY_KIND = {
  origin: feature('origin', { key: null, properties: {} }),
  sketch: SKETCH_SCHEMA,
  plane: feature('plane', { key: 'definition', properties: PLANE_DEF.properties as JsonSchema }),
  extrude: feature('extrude', {
    key: 'extrude',
    required: ['sketch', 'distance'],
    properties: {
      sketch: REF_OR_LIST, distance: NUMBER_OR_EXPR, direction: { enum: ['normal', 'reverse', 'symmetric'] },
      termination: { enum: ['blind', 'up_to'] }, up_to: REF, operation: { enum: ['add', 'cut', 'new'] }, merge_target: REF,
    },
  }),
  revolve: feature('revolve', {
    key: 'revolve',
    required: ['sketch', 'angle', 'axis'],
    properties: {
      sketch: REF_OR_LIST, angle: NUMBER_OR_EXPR, direction: { enum: ['normal', 'reverse', 'symmetric'] },
      axis: REF, operation: { enum: ['add', 'cut', 'new'] }, merge_target: REF,
    },
  }),
  sweep: feature('sweep', {
    key: 'sweep',
    required: ['sketch', 'path'],
    properties: {
      sketch: REF_OR_LIST, path: REF_OR_LIST, transition: { enum: ['mitre', 'round'] },
      multisection: { type: 'boolean' },
      operation: { enum: ['add', 'cut', 'new'] }, merge_target: REF,
    },
  }),
  fillet: feature('fillet', {
    key: 'fillet',
    required: ['edges', 'radius'],
    properties: { edges: REF_LIST, radius: NUMBER_OR_EXPR },
  }),
  chamfer: feature('chamfer', {
    key: 'chamfer',
    required: ['edges', 'distance'],
    properties: {
      edges: REF_LIST, distance: NUMBER_OR_EXPR, kind: { enum: ['distance', 'angle_distance'] }, angle: NUMBER_OR_EXPR,
    },
  }),
  shell: feature('shell', {
    key: 'shell',
    required: ['faces', 'thickness'],
    properties: {
      faces: REF_LIST, thickness: NUMBER_OR_EXPR, direction: { enum: ['inward', 'outward'] }, source_body: REF,
    },
  }),
  move_face: feature('move_face', {
    key: 'move_face',
    required: ['faces', 'distance'],
    properties: { faces: REF_LIST, distance: NUMBER_OR_EXPR },
  }),
  delete_face: feature('delete_face', {
    key: 'delete_face',
    required: ['faces'],
    properties: { faces: REF_LIST },
  }),
  boolean: feature('boolean', {
    key: 'boolean',
    required: ['operation', 'target', 'tools'],
    properties: {
      operation: { enum: ['union', 'subtract', 'intersect'] }, target: REF, tools: REF_LIST,
      keep_tools: { type: 'boolean' }, clearance: NUMBER_OR_EXPR,
    },
  }),
  array: feature('array', {
    key: 'array',
    properties: {
      source_body: REF, mode: { enum: ['linear', 'rectangular'] }, operation: { enum: ['add', 'new'] },
      include_source: { type: 'boolean' }, count_x: NUMBER_OR_EXPR, count_y: NUMBER_OR_EXPR,
      pitch_x: NUMBER_OR_EXPR, pitch_y: NUMBER_OR_EXPR, direction_x: VEC3, direction_y: VEC3,
      direction_x_query: REF, direction_y_query: REF, invert_x: { type: 'boolean' }, invert_y: { type: 'boolean' },
    },
  }),
  circular_array: feature('circular_array', {
    key: 'circular_array',
    properties: {
      source_body: REF, operation: { enum: ['add', 'new'] }, include_source: { type: 'boolean' },
      count: NUMBER_OR_EXPR, step_angle: NUMBER_OR_EXPR, axis: REF, axis_origin: VEC3, axis_direction: VEC3,
      invert_axis: { type: 'boolean' },
    },
  }),
  delete_body: feature('delete_body', {
    key: 'delete_body',
    required: ['bodies'],
    properties: { bodies: REF_LIST },
  }),
  hole: feature('hole', {
    key: 'hole',
    // depth sizes a blind bore only: a through_all bore is sized by the body it
    // cuts, so requiring a depth there made the catalog demand a value the
    // kernel then ignored.
    required: ['sketch', 'diameter', 'depth_mode'],
    allOf: [
      {
        if: { properties: { depth_mode: { const: 'blind' } }, required: ['depth_mode'] },
        then: { required: ['depth'] },
      },
    ],
    properties: {
      sketch: REF, diameter: NUMBER_OR_EXPR, depth_mode: { enum: ['blind', 'through_all'] },
      depth: NUMBER_OR_EXPR,
      // `normal` is the plane's own normal. A face sketch's plane normal is the
      // face's OUTWARD normal, so the default drills away from the material
      // there; the kernel warns when a blind hole misses every site that way.
      direction: {
        enum: ['normal', 'reverse'],
        description: "normal is the sketch plane's normal; a face sketch's normal points out of its face, so a hole on a face usually wants reverse. A through_all hole under normal drills whichever side its sites find the material on; reverse is obeyed as written",
      },
      target: REF,
      style: { enum: ['simple', 'counterbore', 'countersink'] },
      cb_diameter: NUMBER_OR_EXPR, cb_depth: NUMBER_OR_EXPR, cs_angle: NUMBER_OR_EXPR,
      thread: {
        type: 'object',
        required: ['designation', 'nominal', 'pitch'],
        properties: {
          designation: { type: 'string', minLength: 1 },
          nominal: { type: 'number', exclusiveMinimum: 0 },
          pitch: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
    },
  }),
  transform: feature('transform', {
    key: 'transform',
    required: ['bodies'],
    properties: {
      bodies: REF_LIST, operation: { enum: ['new', 'replace'] }, translation: VEC3,
      translation_from: REF, translation_to: REF, rotation_axis: REF, rotation_angle: NUMBER_OR_EXPR,
      rotation_axis_origin: VEC3, rotation_axis_direction: VEC3, scale: NUMBER_OR_EXPR,
      scale_center: VEC3, scale_center_from: REF,
    },
  }),
  mirror: feature('mirror', {
    key: 'mirror',
    required: ['body', 'plane'],
    properties: { body: REF, plane: REF, keep_original: { type: 'boolean' }, merge: { type: 'boolean' } },
  }),
  split: feature('split', {
    key: 'split',
    required: ['bodies', 'plane'],
    properties: {
      bodies: REF_LIST,
      plane: REF,
      keep: {
        enum: ['above', 'below', 'both'],
        description: 'above is the side the plane normal points to (a picked face normal is outward); default above',
      },
    },
  }),
  variable: feature('variable', {
    key: 'variable',
    required: ['expression'],
    properties: { expression: NUMBER_OR_EXPR, value: { type: 'number' }, unit: { type: 'string' } },
  }),
  helix: feature('helix', {
    key: 'helix',
    properties: {
      // A helix is sketch-class, so it carries the same one-shot consume stamp
      // a sketch does; without this key a shown consumed helix would fail the
      // schema on save.
      auto_hidden: { type: 'boolean' },
      reference: REF, radius_mode: { enum: ['derived', 'entered'] },
      mode: { enum: ['pitch_turns', 'pitch_height', 'turns_height', 'angle_turns', 'angle_height'] },
      hand: { enum: ['right', 'left'] }, direction: { enum: ['normal', 'reverse'] },
      height_from_reference: { type: 'boolean' }, radius: NUMBER_OR_EXPR, pitch: NUMBER_OR_EXPR,
      turns: NUMBER_OR_EXPR, height: NUMBER_OR_EXPR, helix_angle: NUMBER_OR_EXPR, offset: NUMBER_OR_EXPR,
      start_angle: NUMBER_OR_EXPR,
    },
  }),
  import_step: feature('import_step', {
    key: null,
    required: ['file_id'],
    properties: { file_id: { type: 'string', minLength: 1 }, file_data: { type: 'string' }, scale: NUMBER_OR_EXPR },
  }),
} as const satisfies Record<FeatureKind, JsonSchema>

/** The key a feature kind nests its authored params under; null when the kind
 *  keeps them feature-level (sketch, import_step, origin). */
export function featureParamKey(kind: FeatureKind): string | null {
  return FEATURE_PARAM_KEY.get(kind) ?? null
}

/** The schema of the object under a feature kind's param key, or null for a
 *  kind with no such container. Read from FEATURE_SCHEMA_BY_KIND, so a catalog
 *  or a validator sharing it cannot drift from the published schema. */
export function featureParamsSchema(kind: FeatureKind): JsonSchema | null {
  const key = featureParamKey(kind)
  if (key === null) return null
  const properties = FEATURE_SCHEMA_BY_KIND[kind].properties as Record<string, JsonSchema>
  return properties[key] ?? null
}

/** The authored field names of a feature kind's param container, in schema
 *  order. Empty for a kind whose params stay feature-level. */
export function featureFieldNames(kind: FeatureKind): string[] {
  const params = featureParamsSchema(kind)
  if (params === null) return []
  return Object.keys(params.properties as Record<string, JsonSchema>)
}

/** The plane definition object: both the plane feature's `definition` payload
 *  and the fields `set_plane_definition_field` may name. */
export function planeDefinitionSchema(): JsonSchema {
  const params = featureParamsSchema('plane')
  if (params === null) throw new Error('plane feature schema has no definition')
  return params
}

// A separate widening alias so the exported schema reads as a plain record and
// callers do not depend on the literal object shape.
const FEATURE_SCHEMA_LIST: JsonSchema[] = Object.values(FEATURE_SCHEMA_BY_KIND)

export const PART_DOC_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'oversolved://schema/part-document',
  title: 'Oversolved part document',
  type: 'object',
  properties: {
    oversolved: { type: 'integer' },
    version: { type: 'integer' },
    kind: { const: 'part' },
    rollback: { type: 'integer' },
    features: { type: 'array', items: { oneOf: FEATURE_SCHEMA_LIST } },
    part_style: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          name: { type: 'string' }, color: { type: 'string' }, created_by: { type: 'string' },
          visible: { type: 'boolean' }, transparency: { type: 'number' }, metalness: { type: 'number' },
          roughness: { type: 'number' }, transmission: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}

/** The schema as JSON text, for the MCP resource payload. */
export const PART_DOC_SCHEMA_JSON = JSON.stringify(PART_DOC_SCHEMA, null, 2)

/** The MCP resource URI the schema is served at. */
export const PART_DOC_SCHEMA_URI = 'oversolved://schema/part-document'
