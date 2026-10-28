// The assembly-document JSON Schema: the machine-readable contract for the
// document the assembly editor stores and the drive writes. It is served as an
// MCP resource (drive/mcpServer.ts) beside the part schema, so an agent can
// author an assembly without inferring the format from examples.
//
// The per-feature table is keyed by the loader's ASSEMBLY_FEATURE_KINDS and the
// mate kind enum is MATE_KINDS, both through `satisfies`, so a new feature kind
// or mate kind fails to type-check until this contract carries it. The shape
// itself is hand-written for the same reason the part schema is: the compile-time
// tether plus the loader fixtures keep it from drifting.

import { ASSEMBLY_FEATURE_KINDS } from '@/persistence/docSchema'
import { PART_DOC_SCHEMA, planeDefinitionSchema, type JsonSchema } from '@/persistence/partDocSchema'
import { MATE_KINDS } from '@/utils/mateKinds'

type AssemblyFeatureKind = (typeof ASSEMBLY_FEATURE_KINDS)[number]

const VEC3: JsonSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
const NUMBER_OR_EXPR: JsonSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }],
  description: 'A number, or an expression string. Mate expressions are refused by the solve today; send numbers.',
}

const TRANSFORM3D: JsonSchema = {
  type: 'object',
  required: ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'],
  properties: {
    tx: { type: 'number' }, ty: { type: 'number' }, tz: { type: 'number' },
    qx: { type: 'number' }, qy: { type: 'number' }, qz: { type: 'number' }, qw: { type: 'number' },
  },
  additionalProperties: false,
}

const ANCHOR_DESCRIPTOR: JsonSchema = {
  type: 'object',
  required: ['geom_hash', 'kind', 'created_by', 'point'],
  properties: {
    geom_hash: { type: 'string', minLength: 1 },
    kind: { type: 'string' },
    created_by: { type: 'string', minLength: 1 },
    point: VEC3,
  },
  additionalProperties: false,
}

const MATE_REF: JsonSchema = {
  type: 'object',
  required: ['part', 'anchor'],
  properties: {
    part: { type: 'string' },
    anchor: { type: 'string' },
    anchor_descriptor: ANCHOR_DESCRIPTOR,
  },
  additionalProperties: false,
}

const MATE_OFFSET: JsonSchema = {
  anyOf: [
    NUMBER_OR_EXPR,
    {
      type: 'object',
      properties: { x: NUMBER_OR_EXPR, y: NUMBER_OR_EXPR, z: NUMBER_OR_EXPR },
      additionalProperties: false,
    },
  ],
  description: 'A scalar along A\'s anchor axis, or a vector in body A\'s local frame; a missing component is 0.',
}

const MATE_DEF: JsonSchema = {
  type: 'object',
  required: ['kind', 'ref_a', 'ref_b'],
  properties: {
    kind: { enum: [...MATE_KINDS] },
    label: { type: 'string' },
    ref_a: MATE_REF,
    ref_b: MATE_REF,
    flip: { type: 'boolean' },
    ratio: { type: 'number' },
    offset: MATE_OFFSET,
    angle: NUMBER_OR_EXPR,
    radius: NUMBER_OR_EXPR,
  },
  additionalProperties: false,
}

const PART_INSTANCE: JsonSchema = {
  type: 'object',
  required: ['handle', 'doc_id', 'doc_rev', 'transform'],
  properties: {
    handle: { type: 'string', minLength: 1 },
    doc_id: { type: 'string', minLength: 1 },
    doc_rev: { type: 'integer' },
    transform: TRANSFORM3D,
    visible: { type: 'boolean' },
    fixed: { type: 'boolean' },
  },
  additionalProperties: false,
}

const BASE_PROPERTIES: JsonSchema = {
  id: { type: 'string', minLength: 1 },
  visible: { type: 'boolean' },
}

const FEATURE_SCHEMAS = {
  part_instance: {
    type: 'object',
    required: ['id', 'kind', 'instance'],
    properties: { ...BASE_PROPERTIES, kind: { const: 'part_instance' }, instance: PART_INSTANCE },
    additionalProperties: false,
  },
  mate: {
    type: 'object',
    required: ['id', 'kind', 'mate'],
    properties: { ...BASE_PROPERTIES, kind: { const: 'mate' }, mate: MATE_DEF },
    additionalProperties: false,
  },
  origin: {
    type: 'object',
    required: ['id', 'kind'],
    properties: { ...BASE_PROPERTIES, kind: { const: 'origin' } },
    additionalProperties: false,
  },
  plane: {
    type: 'object',
    required: ['id', 'kind'],
    properties: { ...BASE_PROPERTIES, kind: { const: 'plane' }, definition: planeDefinitionSchema() },
    additionalProperties: false,
  },
} as const satisfies Record<AssemblyFeatureKind, JsonSchema>

// The same part-style table the part schema publishes: a body colour entry is
// document data in either kind, so the two contracts cannot disagree about it.
const PART_STYLE = (PART_DOC_SCHEMA.properties as Record<string, JsonSchema>).part_style

export const ASSEMBLY_DOC_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'oversolved://schema/assembly-document',
  title: 'Oversolved assembly document',
  type: 'object',
  properties: {
    oversolved: { type: 'integer' },
    version: { type: 'integer' },
    kind: { const: 'assembly' },
    features: { type: 'array', items: { oneOf: Object.values(FEATURE_SCHEMAS) } },
    part_style: PART_STYLE,
  },
  additionalProperties: false,
}

/** The schema as JSON text, for the MCP resource payload. */
export const ASSEMBLY_DOC_SCHEMA_JSON = JSON.stringify(ASSEMBLY_DOC_SCHEMA, null, 2)

/** The MCP resource URI the schema is served at. */
export const ASSEMBLY_DOC_SCHEMA_URI = 'oversolved://schema/assembly-document'
