// The assembly-document schema contract: the published enums are the loader's
// own lists, every assembly the loader accepts validates against the schema,
// and a fractional doc_rev is refused by both (the loader's integer check and
// the schema's `integer` type).
//
// A small draft-07 walker stands in for a dependency, like the part schema
// test's: the schema uses only the keywords implemented below.

import { describe, it, expect } from 'vitest'
import { ASSEMBLY_DOC_SCHEMA, ASSEMBLY_DOC_SCHEMA_JSON, ASSEMBLY_DOC_SCHEMA_URI } from '../assemblyDocSchema'
import { ASSEMBLY_FEATURE_KINDS, loadAssemblyDoc } from '../docSchema'
import { MATE_KINDS } from '@/utils/mateKinds'
import type { AssemblyDoc } from '@/types/cad'

type JsonSchema = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function valid(schema: JsonSchema, value: unknown): boolean {
  if ('const' in schema && value !== schema.const) return false
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return false
  if (typeof schema.type === 'string' && !matchesType(schema.type, value)) return false
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) return false
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
    if (isRecord(schema.items) && !value.every(entry => valid(schema.items as JsonSchema, entry))) return false
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required) && !(schema.required as string[]).every(key => key in value)) return false
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [key, entry] of Object.entries(value)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) return false
        continue
      }
      if (!valid(properties[key] as JsonSchema, entry)) return false
    }
  }
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).some(branch => valid(branch, value))) return false
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter(branch => valid(branch, value))
    if (matches.length !== 1) return false
  }
  return true
}

const FEATURE_BRANCHES = (ASSEMBLY_DOC_SCHEMA.properties as Record<string, JsonSchema>)
  .features as JsonSchema
const FEATURE_BRANCH_LIST = (FEATURE_BRANCHES.items as JsonSchema).oneOf as JsonSchema[]

function featureBranch(kind: string): JsonSchema {
  const branch = FEATURE_BRANCH_LIST.find(candidate =>
    ((candidate.properties as Record<string, JsonSchema>).kind as JsonSchema).const === kind)
  if (!branch) throw new Error(`no schema branch for ${kind}`)
  return branch
}

const TRANSFORM = { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

const VALID_DOCS: AssemblyDoc[] = [
  { version: 1, kind: 'assembly', features: [] },
  { version: 1, kind: 'assembly', features: [
    { id: 'AssemblyOrigin', kind: 'origin' },
    { id: 'AssemblyTop', kind: 'plane', visible: false, definition: { mode: 'offset', plane: 'AssemblyFront', offset: 10 } },
    { id: 'inst_left', kind: 'part_instance', instance: {
      handle: 'left', doc_id: 'rail_400', doc_rev: 0, transform: TRANSFORM, visible: true, fixed: true,
    } },
    { id: 'm1', kind: 'mate', mate: {
      kind: 'fixed',
      label: 'Fixed 1',
      ref_a: { part: 'left', anchor: 'a_left', anchor_descriptor: {
        geom_hash: '@u|abc', kind: 'plane', created_by: 'ex1', point: [0, 0, 0],
      } },
      ref_b: { part: '__assembly', anchor: 'AssemblyTop' },
      flip: true,
      offset: { z: -11.5 },
      angle: 180,
    } },
    { id: 'm2', kind: 'mate', mate: {
      kind: 'parallel_plane_distance',
      ref_a: { part: 'left', anchor: 'a' },
      ref_b: { part: 'right', anchor: 'b' },
      offset: 5,
    } },
  ] },
  { version: 1, kind: 'assembly', features: [], part_style: { body_ex1: { color: '#fff', visible: true } } },
]

describe('assembly document schema', () => {
  it('publishes the loader kind and mate kind vocabularies', () => {
    const kinds = FEATURE_BRANCH_LIST.map(branch =>
      ((branch.properties as Record<string, JsonSchema>).kind as JsonSchema).const)
    expect(kinds).toEqual([...ASSEMBLY_FEATURE_KINDS])
    const mateKind = ((featureBranch('mate').properties as Record<string, JsonSchema>)
      .mate as JsonSchema).properties as Record<string, JsonSchema>
    expect(mateKind.kind.enum).toEqual([...MATE_KINDS])
  })

  it('is served at its own URI and serialises to JSON', () => {
    expect(ASSEMBLY_DOC_SCHEMA_URI).toBe('oversolved://schema/assembly-document')
    expect(JSON.parse(ASSEMBLY_DOC_SCHEMA_JSON)).toMatchObject({
      $id: ASSEMBLY_DOC_SCHEMA_URI,
      title: 'Oversolved assembly document',
    })
  })

  it('validates every document the loader accepts', () => {
    for (const doc of VALID_DOCS) {
      expect(loadAssemblyDoc(doc).ok, JSON.stringify(doc)).toBe(true)
      expect(valid(ASSEMBLY_DOC_SCHEMA, doc), JSON.stringify(doc)).toBe(true)
    }
  })

  it('refuses a fractional doc_rev in both the loader and the schema', () => {
    const doc = {
      version: 1,
      kind: 'assembly',
      features: [{ id: 'inst', kind: 'part_instance', instance: {
        handle: 'left', doc_id: 'rail', doc_rev: 1.5, transform: TRANSFORM,
      } }],
    }
    expect(loadAssemblyDoc(doc).ok).toBe(false)
    expect(valid(ASSEMBLY_DOC_SCHEMA, doc)).toBe(false)
  })

  it('refuses an unknown mate kind and an unknown feature kind', () => {
    const badMate = {
      version: 1, kind: 'assembly', features: [{ id: 'm1', kind: 'mate', mate: {
        kind: 'weld', ref_a: { part: 'a', anchor: 'x' }, ref_b: { part: 'b', anchor: 'y' },
      } }],
    }
    expect(valid(ASSEMBLY_DOC_SCHEMA, badMate)).toBe(false)
    expect(loadAssemblyDoc(badMate).ok).toBe(false)
    const badKind = { version: 1, kind: 'assembly', features: [{ id: 'x', kind: 'sub_assembly' }] }
    expect(valid(ASSEMBLY_DOC_SCHEMA, badKind)).toBe(false)
    expect(loadAssemblyDoc(badKind).ok).toBe(false)
  })
})
