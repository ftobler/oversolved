// @vitest-environment node
//
// The pure half of the bulk pattern / mirror add forms: the catalog rows and the
// document shape one call produces. The practice round paid seven calls for a
// one-line pattern (batch B F2). The built-document half is
// inlineArrayMirrorAddsReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { seedBuiltins } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
describe('the pattern / mirror inline fields', () => {
  it('publishes the linear inline fields and the one-call note', () => {
    const pattern = mutationInfoOf('add_linear_pattern')
    for (const field of [
      'subject', 'source_body', 'source_features', 'source_feature', 'operation', 'count', 'pitch',
      'direction_query', 'invert', 'second_direction', 'count_2', 'pitch_2',
      'direction_2_query', 'invert_2', 'skip',
    ]) {
      expect(pattern.fields[field], field).toBeDefined()
    }
    expect(pattern.note).toContain('One call may carry the whole linear pattern')
    expect(pattern.note).toContain('set_linear_pattern_field')

    const circular = mutationInfoOf('add_circular_pattern')
    for (const field of ['count', 'angle', 'equal_spacing', 'axis', 'axis_origin', 'axis_direction', 'skip']) {
      expect(circular.fields[field], field).toBeDefined()
    }
    expect(circular.note).toContain('One call may carry the whole circular pattern')

    const mirror = mutationInfoOf('add_mirror')
    for (const field of ['body', 'plane', 'keep_original', 'merge']) {
      expect(mirror.fields[field], field).toBeDefined()
    }
    expect(mirror.note).toContain('set_mirror_field')
  })
})
describe('inline field application', () => {
  it('keeps a second-direction count expression instead of seeding the default', () => {
    const doc = emptyDoc()
    mutationHandlers.add_linear_pattern(doc, {
      type: 'add_linear_pattern', featureId: 'ar1', second_direction: true,
      count: 2, pitch: 20, count_2: 'n', pitch_2: 'p',
    })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature).toMatchObject({
      kind: 'linear_pattern',
      linear_pattern: { second_direction: true, count_2: 'n', pitch_2: 'p' },
    })
  })

  it('clears a default on an explicit empty value, like the setter does', () => {
    const doc = emptyDoc()
    mutationHandlers.add_linear_pattern(doc, { type: 'add_linear_pattern', featureId: 'ar1', count: '' })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature?.kind === 'linear_pattern' ? feature.linear_pattern.count : 'missing').toBeUndefined()
  })

  it('stores no angle for a circular add that named none', () => {
    const mutation = { type: 'add_circular_pattern', featureId: 'ca1' }
    expect(validateMutation(mutation).ok).toBe(true)
    const doc = emptyDoc()
    mutationHandlers.add_circular_pattern(doc, { ...mutation } as never)
    const feature = doc.features?.find(entry => entry.id === 'ca1')
    expect(feature?.kind === 'circular_pattern' ? feature.circular_pattern.angle : 'missing').toBeUndefined()
  })
})
