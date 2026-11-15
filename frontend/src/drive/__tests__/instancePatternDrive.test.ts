// The instance pattern's appliers and drive boundary, without a kernel: the
// document a bare and a full add produce, the target chip toggle, the one-form
// rule, and the skip rule. The built-document half is
// kernel/features/__tests__/instancePatternReal.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddInstancePattern, applyAddInstancePatternTarget, applyRemoveInstancePatternTarget,
  applySetInstancePatternField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'
import { emptyDriveDoc } from '@/drive/headlessOps'
import { mutationInfoOf, validateMutation } from '@/drive/mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'

const makeDoc = (): PartDoc => ({ features: [] })
const patternOf = (doc: PartDoc, index = 0) => featureAt(doc, index, 'instance_pattern').instance_pattern

function refusal(raw: Record<string, unknown>): string {
  const result = validateMutation(raw, { doc: emptyDriveDoc() })
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`)
  return result.error.message
}

describe('applyAddInstancePattern', () => {
  it('inserts a bare instance pattern with the documented defaults', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({
      id: 'ip1',
      kind: 'instance_pattern',
      label: 'Instance Pattern',
      instance_pattern: { subject: 'body', operation: 'add' },
    })
    // The orientation and reverse normal keep the kernel defaults: a bare add
    // stores nothing whose absence already means the same.
    expect(patternOf(doc)).not.toHaveProperty('orientation')
    expect(patternOf(doc)).not.toHaveProperty('reverse_normal')
  })

  it('keeps the sketch or the target list an inline add names', () => {
    const sketchDoc = makeDoc()
    applyAddInstancePattern(sketchDoc, 'ip1', 'Run', { sketch: '@sk1', orientation: 'fixed' })
    expect(patternOf(sketchDoc)).toMatchObject({ sketch: '@sk1', orientation: 'fixed' })
    expect(sketchDoc.features![0].label).toBe('Run')

    const targetsDoc = makeDoc()
    applyAddInstancePattern(targetsDoc, 'ip2', undefined, { targets: ['?@ex1:flatface'], reverse_normal: true })
    expect(patternOf(targetsDoc)).toMatchObject({ targets: ['?@ex1:flatface'], reverse_normal: true })
  })

  it('folds the legacy single source into the list and drops the body operation', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { subject: 'feature', source_feature: '@ex1', sketch: '@sk1' })
    expect(patternOf(doc).source_features).toEqual(['@ex1'])
    expect(patternOf(doc)).not.toHaveProperty('source_feature')
    expect(patternOf(doc)).not.toHaveProperty('operation')
  })

  it('refuses both target forms and a skip grid cell', () => {
    const both = makeDoc()
    applyAddInstancePattern(both, 'ip1', undefined, { sketch: '@sk1', targets: ['entity:sk1:p1'] })
    expect(both.features).toHaveLength(0)

    const cell = makeDoc()
    applyAddInstancePattern(cell, 'ip1', undefined, { sketch: '@sk1', skip: [[1, 2]] as never })
    expect(cell.features).toHaveLength(0)
  })
})

describe('instance pattern field appliers', () => {
  it('sets a field through the setter rules', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { sketch: '@sk1' })
    applySetInstancePatternField(doc, 'ip1', 'orientation', 'fixed')
    expect(patternOf(doc).orientation).toBe('fixed')
    applySetInstancePatternField(doc, 'ip1', 'skip', [2])
    expect(patternOf(doc).skip).toEqual([2])
    applySetInstancePatternField(doc, 'ip1', 'skip', null)
    expect(patternOf(doc)).not.toHaveProperty('skip')
  })

  it('toggles and removes a target ref', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { targets: ['?@ex1:flatface'] })
    applyAddInstancePatternTarget(doc, 'ip1', '?@ex1:cylinderface')
    expect(patternOf(doc).targets).toEqual(['?@ex1:flatface', '?@ex1:cylinderface'])
    applyAddInstancePatternTarget(doc, 'ip1', '?@ex1:cylinderface')
    expect(patternOf(doc).targets).toEqual(['?@ex1:flatface'])
    applyRemoveInstancePatternTarget(doc, 'ip1', 0)
    expect(patternOf(doc).targets).toEqual([])
  })

  it('refuses a single write that would leave both target forms set', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { targets: ['?@ex1:flatface'] })
    applySetInstancePatternField(doc, 'ip1', 'sketch', '@sk1')
    expect(patternOf(doc)).not.toHaveProperty('sketch')
    expect(patternOf(doc).targets).toEqual(['?@ex1:flatface'])
    // Clearing the list first is the documented switch.
    applySetInstancePatternField(doc, 'ip1', 'targets', [])
    applySetInstancePatternField(doc, 'ip1', 'sketch', '@sk1')
    expect(patternOf(doc).sketch).toBe('@sk1')
  })
})

describe('the instance pattern mutation catalog', () => {
  it('lists the add, the setter and the two target chips', () => {
    for (const type of ['add_instance_pattern', 'set_instance_pattern_field', 'add_instance_pattern_target', 'remove_instance_pattern_target'] as const) {
      expect(mutationInfoOf(type).summary.length, type).toBeGreaterThan(0)
    }
    const add = mutationInfoOf('add_instance_pattern')
    for (const field of ['sketch', 'targets', 'reference', 'orientation', 'reverse_normal', 'skip']) {
      expect(add.fields[field], field).toBeDefined()
    }
    // A target list is the instance list: no count and no centered option.
    expect(add.fields.count).toBeUndefined()
    expect(add.fields.centered).toBeUndefined()
    expect(add.note ?? '').toContain('There is no count and no centered option')
    expect(add.note ?? '').toContain('free end')
    expect(mutationInfoOf('set_instance_pattern_field').fields.field.note).toContain('orientation')
  })

  it('accepts a full add payload', () => {
    const raw = {
      type: 'add_instance_pattern', featureId: 'ip1', subject: 'body',
      source_body: '@body_ex1', sketch: '@sk1', reference: '@builtin_plane_top',
      orientation: 'normal', reverse_normal: true, skip: [2, 3],
    }
    expect(validateMutation(raw, { doc: emptyDriveDoc() })).toMatchObject({ ok: true })
  })
})

describe('instance pattern boundary refusals', () => {
  it('refuses both target forms in one add', () => {
    expect(refusal({
      type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1', targets: ['?@ex1:flatface'],
    })).toContain('sketch and targets cannot both be set')
  })

  it('refuses a grid cell by name', () => {
    expect(refusal({ type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1', skip: [[1, 2]] }))
      .toContain('an instance pattern has no grid cells')
    expect(validateMutation(
      { type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1', skip: [[1, 0]] },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
  })

  it('refuses an unknown orientation', () => {
    expect(refusal({ type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1', orientation: 'spin' }))
      .toContain('orientation')
  })

  it('judges a setter against the stored sibling', () => {
    const doc = emptyDriveDoc()
    mutationHandlers.add_instance_pattern(doc, {
      type: 'add_instance_pattern', featureId: 'ip1', targets: ['?@ex1:flatface'],
    })
    const result = validateMutation(
      { type: 'set_instance_pattern_field', featureId: 'ip1', field: 'sketch', value: '@sk1' },
      { doc },
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error.message).toContain('sketch and targets cannot both be set')
  })

  it('refuses a setter skip with a grid cell', () => {
    expect(refusal({
      type: 'set_instance_pattern_field', featureId: 'ip1', field: 'skip', value: [[1, 2]],
    })).toContain('an instance pattern has no grid cells')
  })
})
