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
      subject: 'feature', source_feature: '@ex1', mode: 'linear', count: 3, pitch: 20, direction: [1, 0, 0],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].pattern).toEqual({
      subject: 'feature', source_feature: '@ex1', mode: 'linear', count: 3, pitch: 20, direction: [1, 0, 0],
    })
  })

  it('accepts a circular pattern with the stored axis pair', () => {
    expect(loadPartDoc(doc({
      subject: 'feature', source_feature: '@ex1', mode: 'circular', count: 4, step_angle: 90,
      axis_origin: [0, 0, 0], axis_direction: [0, 0, 1], invert_axis: true,
    })).ok).toBe(true)
  })

  it('refuses an unknown mode, naming all three', () => {
    const result = loadPartDoc(doc({ subject: 'feature', source_feature: '@ex1', mode: 'polar' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].pattern.mode')
    expect(result.error.message).toContain('"linear"')
    expect(result.error.message).toContain('"rectangular"')
    expect(result.error.message).toContain('"circular"')
  })

  it('refuses a count the loader would refuse', () => {
    for (const count of [0, -2, 2.5]) {
      const result = loadPartDoc(doc({ subject: 'feature', source_feature: '@ex1', count }))
      expect(result.ok, String(count)).toBe(false)
      if (result.ok) continue
      expect(result.error.field).toBe('features[0].pattern.count')
    }
  })

  it('accepts a legacy count 1 and a 1x1 grid, which the kernel refuses', () => {
    // The loader keeps old documents open; the kernel names the source-in-count
    // refusal when the pattern solves. See patternReal.test.ts for that half.
    const legacy = loadPartDoc(doc({ subject: 'body', source_body: '@b1', count: 1 }))
    expect(legacy.ok).toBe(true)
    const square = loadPartDoc(doc({ subject: 'body', mode: 'rectangular', count_x: 1, count_y: 1 }))
    expect(square.ok).toBe(true)
    expect(loadPartDoc(doc({ subject: 'body', mode: 'rectangular', count_x: 1, count_y: 2 })).ok).toBe(true)
  })

  it('accepts the retired include_source key on an old document', () => {
    // Load tolerance is deliberate: the kernel ignores the flag now, but a file
    // saved before that change must still open.
    const result = loadPartDoc(doc({
      subject: 'body', source_body: '@b1', mode: 'linear', count: 3, include_source: false,
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].pattern).toMatchObject({
      count: 3, include_source: false,
    })
  })

  it('refuses a non-string source and a malformed direction', () => {
    const source = loadPartDoc(doc({ subject: 'feature', source_feature: 5 }))
    expect(source.ok).toBe(false)
    if (!source.ok) expect(source.error.field).toBe('features[0].pattern.source_feature')

    const direction = loadPartDoc(doc({ subject: 'feature', source_feature: '@ex1', direction: [1, 0] }))
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
