// The part-document schema contract. Every oracle recipe (as the loader
// migrates it) validates, and the two legacy spellings this feature collapsed
// fail by field: a flat param and a feature-level `$` reference.
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { PART_DOC_SCHEMA, PART_DOC_SCHEMA_JSON, PART_DOC_SCHEMA_URI } from '@/persistence/partDocSchema'
import { listOracleCases } from '@/oracle/corpus'
import { partSpecFromText } from '@/utils/partExport'
import type { FeatureKind } from '@/types/cad'

const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(PART_DOC_SCHEMA)

function errorsText(): string {
  return (validate.errors ?? []).map(e => {
    const extra = 'additionalProperty' in e.params ? ` ${String(e.params.additionalProperty)}` : ''
    return `${e.dataPath || '/'} ${e.keyword}${extra} ${e.message ?? ''}`
  }).join('; ')
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
    const branches = (PART_DOC_SCHEMA.properties as Record<string, { items: { oneOf: unknown[] } }>).features.items.oneOf
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
      if (!validate(doc)) failures.push(`${oracleCase.name}: ${errorsText()}`)
    }
    expect(failures).toEqual([])
  })

  it('rejects a flat param, naming the field', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', distance: 5, extrude: { sketch: '@sk1' } }],
    }
    expect(validate(doc)).toBe(false)
    expect(errorsText()).toContain('distance')
  })

  it('rejects a feature-level $ reference, naming the field', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 5 } }],
    }
    expect(validate(doc)).toBe(false)
    const text = errorsText()
    expect(text).toContain('sketch')
  })

  it('accepts the canonical form of both', () => {
    const doc = {
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 5 } }],
    }
    expect(validate(doc), errorsText()).toBe(true)
  })
})
