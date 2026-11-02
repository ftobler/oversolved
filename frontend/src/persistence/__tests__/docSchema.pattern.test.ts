// The pattern kind's boundary checks: a well-formed pattern loads and keeps its
// payload, and the shapes the kernel would have to guess at (an unknown mode, a
// non-ref source, a count the solve cannot use) are refused by field.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND, featureParamsSchema } from '@/persistence/partDocSchema'

function doc(pattern: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'pt1', kind: 'pattern', pattern }] }
}

describe('pattern document validation', () => {
  it('accepts a valid linear pattern and keeps its payload', () => {
    const result = loadPartDoc(doc({
      source_feature: '@ex1', mode: 'linear', count: 3, pitch: 20, direction: [1, 0, 0],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].pattern).toEqual({
      source_feature: '@ex1', mode: 'linear', count: 3, pitch: 20, direction: [1, 0, 0],
    })
  })

  it('accepts a circular pattern with the stored axis pair', () => {
    expect(loadPartDoc(doc({
      source_feature: '@ex1', mode: 'circular', count: 4, step_angle: 90,
      axis_origin: [0, 0, 0], axis_direction: [0, 0, 1], invert_axis: true,
    })).ok).toBe(true)
  })

  it('refuses an unknown mode, naming the two', () => {
    const result = loadPartDoc(doc({ source_feature: '@ex1', mode: 'polar' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].pattern.mode')
    expect(result.error.message).toContain('"linear"')
    expect(result.error.message).toContain('"circular"')
  })

  it('refuses a count the loader would refuse', () => {
    for (const count of [0, -2, 2.5]) {
      const result = loadPartDoc(doc({ source_feature: '@ex1', count }))
      expect(result.ok, String(count)).toBe(false)
      if (result.ok) continue
      expect(result.error.field).toBe('features[0].pattern.count')
    }
  })

  it('refuses a non-string source and a malformed direction', () => {
    const source = loadPartDoc(doc({ source_feature: 5 }))
    expect(source.ok).toBe(false)
    if (!source.ok) expect(source.error.field).toBe('features[0].pattern.source_feature')

    const direction = loadPartDoc(doc({ source_feature: '@ex1', direction: [1, 0] }))
    expect(direction.ok).toBe(false)
    if (!direction.ok) expect(direction.error.field).toBe('features[0].pattern.direction')
  })

  it('publishes the params under the kind key with a feature-ref pattern', () => {
    const schema = FEATURE_SCHEMA_BY_KIND.pattern
    expect(schema.additionalProperties).toBe(false)
    const properties = schema.properties as Record<string, unknown>
    expect(properties).toHaveProperty('pattern')
    expect(properties).not.toHaveProperty('source_feature')
    const params = featureParamsSchema('pattern')!
    const source = (params.properties as Record<string, Record<string, unknown>>).source_feature
    const pattern = new RegExp(source.pattern as string)
    expect(pattern.test('$ex1')).toBe(false)
    expect(pattern.test('@ex1')).toBe(true)
  })
})
