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

type JsonSchema = Record<string, unknown>

/** A feature-level reference to a feature, a body or a query. It never starts
 *  with `$`: `$` is host-local to the owning sketch's entities, not a
 *  feature-to-feature ref. The negative lookahead accepts `@`, `?`, `entity:`
 *  and `vertex:` forms. */
const REF: JsonSchema = { type: 'string', pattern: '^(?!\\$)' }
const REF_LIST: JsonSchema = { type: 'array', items: REF }
const REF_OR_LIST: JsonSchema = { anyOf: [REF, REF_LIST] }
const NUMBER_OR_EXPR: JsonSchema = { anyOf: [{ type: 'number' }, { type: 'string' }] }
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
}

function feature(kind: FeatureKind, sub: SubDef): JsonSchema {
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
const FEATURE_SCHEMA_BY_KIND = {
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
    required: ['sketch', 'angle'],
    properties: {
      sketch: REF_OR_LIST, angle: NUMBER_OR_EXPR, direction: { enum: ['normal', 'reverse', 'symmetric'] },
      axis: REF, operation: { enum: ['add', 'cut', 'new'] }, merge_target: REF,
    },
  }),
  sweep: feature('sweep', {
    key: 'sweep',
    required: ['sketch', 'path'],
    properties: {
      sketch: REF_OR_LIST, path: REF_OR_LIST, operation: { enum: ['add', 'cut', 'new'] }, merge_target: REF,
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
    required: ['sketch', 'diameter', 'depth_mode', 'depth'],
    properties: {
      sketch: REF, diameter: NUMBER_OR_EXPR, depth_mode: { enum: ['blind', 'through_all'] },
      depth: NUMBER_OR_EXPR, direction: { enum: ['normal', 'reverse'] }, target: REF,
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
  variable: feature('variable', {
    key: 'variable',
    required: ['expression'],
    properties: { expression: NUMBER_OR_EXPR, value: { type: 'number' }, unit: { type: 'string' } },
  }),
  helix: feature('helix', {
    key: 'helix',
    properties: {
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
