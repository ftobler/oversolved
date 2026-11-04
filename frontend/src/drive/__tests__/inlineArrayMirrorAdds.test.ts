// @vitest-environment node
//
// The pure half of the bulk `add_pattern` / `add_mirror` forms: the catalog
// rows and the document shape one call produces. The practice round paid seven
// calls for a one-line pattern (batch B F2). The built-document half is
// inlineArrayMirrorAddsReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { seedBuiltins } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
describe('add_pattern / add_mirror inline fields', () => {
  it('publishes the inline fields and the one-call note', () => {
    const pattern = mutationInfoOf('add_pattern')
    for (const field of [
      'subject', 'source_body', 'source_feature', 'operation', 'count', 'pitch',
      'direction_query', 'invert', 'count_x', 'pitch_x', 'direction_x_query', 'invert_x',
      'count_y', 'pitch_y', 'direction_y_query', 'invert_y', 'step_angle', 'axis',
    ]) {
      expect(pattern.fields[field], field).toBeDefined()
    }
    expect(pattern.note).toContain('One call may carry the whole pattern')
    expect(pattern.note).toContain('set_pattern_field')

    const mirror = mutationInfoOf('add_mirror')
    for (const field of ['body', 'plane', 'keep_original', 'merge']) {
      expect(mirror.fields[field], field).toBeDefined()
    }
    expect(mirror.note).toContain('set_mirror_field')
  })
})
describe('inline field application', () => {
  it('keeps a rectangular count_y expression instead of seeding the default', () => {
    const doc = emptyDoc()
    mutationHandlers.add_pattern(doc, {
      type: 'add_pattern', featureId: 'ar1', mode: 'rectangular',
      count_x: 2, pitch_x: 20, count_y: 'n', pitch_y: 'p',
    })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature).toMatchObject({
      kind: 'pattern',
      pattern: { mode: 'rectangular', count_y: 'n', pitch_y: 'p' },
    })
  })

  it('clears a default on an explicit empty value, like the setter does', () => {
    const doc = emptyDoc()
    mutationHandlers.add_pattern(doc, { type: 'add_pattern', featureId: 'ar1', count: '' })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature?.kind === 'pattern' ? feature.pattern.count : 'missing').toBeUndefined()
  })

  it('accepts a null step_angle and stores no key for it', () => {
    const mutation = { type: 'add_pattern', featureId: 'ca1', mode: 'circular', step_angle: null }
    expect(validateMutation(mutation).ok).toBe(true)
    const doc = emptyDoc()
    mutationHandlers.add_pattern(doc, { ...mutation } as never)
    const feature = doc.features?.find(entry => entry.id === 'ca1')
    expect(feature?.kind === 'pattern' ? feature.pattern.step_angle : 'missing').toBeUndefined()
  })
})
