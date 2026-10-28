// The split kind's boundary checks: a well-formed split loads, and the shapes
// that would break the solve (an unknown keep side, a non-ref plane, a bodies
// field that is not a list, a sketch-local `$` plane) are refused by field.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND, featureParamsSchema } from '@/persistence/partDocSchema'

function doc(split: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'sp1', kind: 'split', split }] }
}

describe('split document validation', () => {
  it('accepts a valid split and keeps its payload', () => {
    const result = loadPartDoc(doc({ bodies: ['@ex1'], plane: '@pl1', keep: 'both' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].split).toEqual({
      bodies: ['@ex1'], plane: '@pl1', keep: 'both',
    })
  })

  it('accepts an absent keep (the above default)', () => {
    expect(loadPartDoc(doc({ bodies: [], plane: '?4;@ex1:flatface' })).ok).toBe(true)
  })

  it('refuses an unknown keep value, naming the three sides', () => {
    const result = loadPartDoc(doc({ bodies: ['@ex1'], plane: '@pl1', keep: 'top' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].split.keep')
    expect(result.error.message).toContain('"above"')
    expect(result.error.message).toContain('"below"')
    expect(result.error.message).toContain('"both"')
  })

  it('refuses a non-string plane by field', () => {
    const result = loadPartDoc(doc({ bodies: ['@ex1'], plane: 5 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].split.plane')
  })

  it('refuses a bodies field that is not a list', () => {
    const result = loadPartDoc(doc({ bodies: '@ex1', plane: '@pl1' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].split.bodies')
  })

  it('refuses a sketch-local $ plane ref through the schema ref pattern', () => {
    // The loader folds flat params and does not enforce the pattern; the
    // published schema is the contract that refuses `$` at feature level.
    const params = featureParamsSchema('split')!
    const plane = (params.properties as Record<string, Record<string, unknown>>).plane
    const pattern = new RegExp(plane.pattern as string)
    expect(pattern.test('$sk1')).toBe(false)
    expect(pattern.test('@pl1')).toBe(true)
  })

  it('refuses the params written flat on the feature', () => {
    const schema = FEATURE_SCHEMA_BY_KIND.split
    expect(schema.additionalProperties).toBe(false)
    const properties = schema.properties as Record<string, unknown>
    expect(properties).not.toHaveProperty('plane')
    expect(properties).toHaveProperty('split')
  })
})
