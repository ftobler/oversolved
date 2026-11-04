// @vitest-environment node
//
// The pattern's drive surface without a kernel: the two catalog rows, their
// note (the total-count convention and the two modes), the document one inline
// add produces, and the boundary refusals with their fixes. The built-document
// half is patternDriveReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { emptyDriveDoc } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'

function refusal(raw: Record<string, unknown>): string {
  const result = validateMutation(raw, { doc: emptyDriveDoc() })
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`)
  return result.error.message
}

describe('the pattern mutation catalog', () => {
  it('lists the two mutations and states the count and modes', () => {
    for (const type of ['add_pattern', 'set_pattern_field'] as const) {
      const info = mutationInfoOf(type)
      expect(info.summary.length).toBeGreaterThan(0)
      expect(info.note ?? '', type).toContain('TOTAL instance count')
      expect(info.note ?? '', type).toContain('Linear mode')
      expect(info.note ?? '', type).toContain('circular')
    }
  })

  it('publishes add_pattern fields and set_pattern_field as a setter', () => {
    const add = mutationInfoOf('add_pattern')
    for (const field of ['source_feature', 'mode', 'count', 'pitch', 'direction', 'step_angle', 'axis', 'target_body']) {
      expect(add.fields[field], field).toBeDefined()
    }
    expect(mutationInfoOf('set_pattern_field').fields.field.note).toContain('source_feature')
    expect(PART_DOC_SCHEMA_JSON).toContain('"pattern"')
    expect(PART_DOC_SCHEMA_JSON).toContain('"circular"')
  })
})

describe('pattern boundary refusals', () => {
  it('refuses an unknown mode, naming the two', () => {
    const message = refusal({ type: 'add_pattern', featureId: 'pt1', mode: 'polar' })
    expect(message).toContain('"linear"')
    expect(message).toContain('"circular"')
  })

  it('refuses a sketch-local source ref', () => {
    expect(refusal({ type: 'add_pattern', featureId: 'pt1', source_feature: '$ex1' })).toContain('"$"')
  })

  it('refuses a malformed direction and a non-list value', () => {
    expect(refusal({ type: 'add_pattern', featureId: 'pt1', direction: [1] })).toContain('direction')
    expect(refusal({ type: 'set_pattern_field', featureId: 'pt1', field: 'count', value: {} })).toContain('count')
  })

  it('refuses an unknown setter field by name', () => {
    expect(refusal({ type: 'set_pattern_field', featureId: 'pt1', field: 'spacing', value: 5 })).toContain('spacing')
  })
})

describe('one inline add lands the whole pattern', () => {
  it('stores the source, mode, count, pitch and direction in one call', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_pattern(doc, {
      type: 'add_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
      source_feature: '@ex1', mode: 'linear', count: 4, pitch: 8,
      direction: [1, 0, 0], invert: true, target_body: '@body_ex1',
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'pattern',
      pattern: {
        subject: 'feature', source_feature: '@ex1', mode: 'linear', count: 4, pitch: 8,
        direction: [1, 0, 0], invert: true, target_body: '@body_ex1',
      },
    })
  })
})
