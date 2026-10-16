// The part-document schema contract. Every oracle recipe (as the loader
// migrates it) validates, and the two legacy spellings this feature collapsed
// fail by field: a flat param and a feature-level `$` reference.
//
// A ~90-line draft-07 subset validator stands in for a dependency: the schema
// uses only const/enum/type/pattern/required/additionalProperties/properties/
// items/oneOf/anyOf, and importing ajv (a transitive package, not a declared
// one) would break the undeclared-dependency convention test.
import { describe, it, expect } from 'vitest'
import { PART_DOC_SCHEMA, PART_DOC_SCHEMA_JSON, PART_DOC_SCHEMA_URI } from '@/persistence/partDocSchema'
import { listOracleCases } from '@/oracle/corpus'
import { partSpecFromText } from '@/utils/partExport'
import type { FeatureKind } from '@/types/cad'

type JsonSchema = Record<string, unknown>

interface ValidationError {
  path: string
  keyword: string
  message: string
}

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

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: ValidationError[]): void {
  if ('const' in schema && value !== schema.const) {
    errors.push({ path, keyword: 'const', message: `expected ${JSON.stringify(schema.const)}` })
  }
  if ('enum' in schema && !(schema.enum as unknown[]).includes(value)) {
    errors.push({ path, keyword: 'enum', message: `expected one of ${JSON.stringify(schema.enum)}` })
  }
  if ('type' in schema && !matchesType(schema.type as string, value)) {
    errors.push({ path, keyword: 'type', message: `expected ${String(schema.type)}` })
    return
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path, keyword: 'pattern', message: `must match ${schema.pattern}` })
  }
  if (Array.isArray(schema.required) && isRecord(value)) {
    for (const key of schema.required as string[]) {
      if (!(key in value)) errors.push({ path, keyword: 'required', message: `missing ${key}` })
    }
  }
  if (Array.isArray(value) && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) validateNode(schema.items as JsonSchema, value[i], `${path}[${i}]`, errors)
  }
  if ('anyOf' in schema) {
    const ok = (schema.anyOf as JsonSchema[]).some(s => {
      const branch: ValidationError[] = []
      validateNode(s, value, path, branch)
      return branch.length === 0
    })
    if (!ok) errors.push({ path, keyword: 'anyOf', message: 'no schema matched' })
  }
  if ('oneOf' in schema) {
    const branches = schema.oneOf as JsonSchema[]
    const matched = branches.filter(s => {
      const branch: ValidationError[] = []
      validateNode(s, value, path, branch)
      return branch.length === 0
    })
    if (matched.length !== 1) {
      errors.push({ path, keyword: 'oneOf', message: `matched ${matched.length} schemas` })
      // Surface the discriminator branch's own errors so a failure names the
      // offending field instead of just "no branch matched".
      const kind = isRecord(value) ? value.kind : undefined
      for (const branch of branches) {
        const props = branch.properties as Record<string, { const?: unknown }> | undefined
        if (props?.kind && props.kind.const === kind) validateNode(branch, value, path, errors)
      }
    }
  }
  if (isRecord(value) && 'properties' in schema) {
    const props = schema.properties as Record<string, JsonSchema>
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(sub, value[key], `${path}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: `unexpected ${key}` })
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) validateNode(schema.additionalProperties, value[key], `${path}.${key}`, errors)
      }
    }
  }
}

function validate(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  validateNode(PART_DOC_SCHEMA, doc, '', errors)
  return errors
}

function errorsText(errors: ValidationError[]): string {
  return errors.map(e => `${e.path || '/'} ${e.keyword} ${e.message}`).join('; ')
}

describe('part-document schema', () => {
  it('is served at a stable URI', () => {
    expect(PART_DOC_SCHEMA_URI).toBe('oversolved://schema/part-document')
    expect(JSON.parse(PART_DOC_SCHEMA_JSON)).toMatchObject({ $id: PART_DOC_SCHEMA_URI })
  })

  it('carries one feature branch per kind', () => {
    // Guards the guard: a dropped branch would silently accept fewer kinds. The
    // compile-time tether is FEATURE_SCHEMA_BY_KIND's `satisfies
    // Record<FeatureKind, JsonSchema>` in partDocSchema.ts.
    const properties = PART_DOC_SCHEMA.properties as Record<string, { items: { oneOf: unknown[] } }>
    const branches = properties.features.items.oneOf
    const kinds = branches.map(b => (b as { properties: { kind: { const: FeatureKind } } }).properties.kind.const)
    expect(new Set(kinds).size).toBe(branches.length)
    for (const kind of ['extrude', 'revolve', 'sweep', 'hole', 'fillet', 'chamfer', 'shell', 'boolean', 'array', 'plane', 'sketch', 'import_step'] as FeatureKind[]) {
      expect(kinds).toContain(kind)
    }
  })

  it('validates every oracle recipe as the loader migrates it', () => {
    const failures: string[] = []
    for (const oracleCase of listOracleCases()) {
      const doc = partSpecFromText(oracleCase.recipe)
      const errors = validate(doc)
      if (errors.length > 0) failures.push(`${oracleCase.name}: ${errorsText(errors)}`)
    }
    expect(failures).toEqual([])
  })

  it('rejects a flat param, naming the field', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', distance: 5, extrude: { sketch: '@sk1' } }],
    }
    const errors = validate(doc)
    expect(errors.length).toBeGreaterThan(0)
    expect(errorsText(errors)).toContain('distance')
  })

  it('rejects a feature-level $ reference, naming the field', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 5 } }],
    }
    const errors = validate(doc)
    expect(errors.length).toBeGreaterThan(0)
    expect(errorsText(errors)).toContain('sketch')
  })

  it('accepts the canonical form of both', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5 } }],
    }
    const errors = validate(doc)
    expect(errors, errorsText(errors)).toEqual([])
  })
})
