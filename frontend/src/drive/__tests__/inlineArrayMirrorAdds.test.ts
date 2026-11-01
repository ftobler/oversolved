// @vitest-environment node
//
// The bulk `add_array` / `add_circular_array` / `add_mirror` forms: one call
// carrying the source, counts, pitches, axis or plane must land the same
// document as the old feature + one setter per field sequence. The practice
// round paid seven calls for a one-line linear array (batch B F2).

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { seedBuiltins } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}
describe('add_array / add_circular_array / add_mirror inline fields', () => {
  it('publishes the inline fields and the one-call note', () => {
    const array = mutationInfoOf('add_array')
    for (const field of ['source_body', 'mode', 'operation', 'count_x', 'pitch_x', 'direction_x_query', 'invert_x']) {
      expect(array.fields[field], field).toBeDefined()
    }
    expect(array.note).toContain('One call may carry the whole array')
    expect(array.note).toContain('set_array_field')

    const circular = mutationInfoOf('add_circular_array')
    for (const field of ['source_body', 'operation', 'count', 'step_angle', 'axis', 'axis_origin', 'axis_direction']) {
      expect(circular.fields[field], field).toBeDefined()
    }
    expect(circular.note).toContain('One call may carry the whole array')
    expect(circular.note).toContain('set_circular_array_field')

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
    mutationHandlers.add_array(doc, {
      type: 'add_array', featureId: 'ar1', mode: 'rectangular',
      count_x: 2, pitch_x: 20, count_y: 'n', pitch_y: 'p',
    })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature).toMatchObject({
      kind: 'array',
      array: { mode: 'rectangular', count_y: 'n', pitch_y: 'p' },
    })
  })

  it('clears a default on an explicit empty value, like the setter does', () => {
    const doc = emptyDoc()
    mutationHandlers.add_array(doc, { type: 'add_array', featureId: 'ar1', count_x: '' })
    const feature = doc.features?.find(entry => entry.id === 'ar1')
    expect(feature?.kind === 'array' ? feature.array.count_x : 'missing').toBeUndefined()
  })

  it('accepts a null step_angle and stores no key for it', () => {
    const mutation = { type: 'add_circular_array', featureId: 'ca1', step_angle: null }
    expect(validateMutation(mutation).ok).toBe(true)
    const doc = emptyDoc()
    mutationHandlers.add_circular_array(doc, { ...mutation } as never)
    const feature = doc.features?.find(entry => entry.id === 'ca1')
    expect(feature?.kind === 'circular_array' ? feature.circular_array.step_angle : 'missing').toBeUndefined()
  })
})
