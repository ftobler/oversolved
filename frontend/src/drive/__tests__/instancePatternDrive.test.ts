// The instance pattern's appliers and drive boundary, without a kernel: the
// document a bare and a full add produce, the one target list (a sketch ref is
// a row that expands to its points), the retired `sketch` alias, and the skip
// rule. The built-document half is
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
import { instanceSketchAliasNote } from '@/drive/patternAlias'
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

  it('stores the target list an inline add names', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', 'Run', { targets: ['?@ex1:flatface'], orientation: 'fixed' })
    expect(patternOf(doc)).toMatchObject({ targets: ['?@ex1:flatface'], orientation: 'fixed' })
    expect(doc.features![0].label).toBe('Run')
  })

  it('rewrites the retired sketch key into the leading target', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { sketch: '@sk1', orientation: 'fixed' })
    expect(patternOf(doc)).toEqual({ subject: 'body', operation: 'add', targets: ['@sk1'], orientation: 'fixed' })
    expect(patternOf(doc)).not.toHaveProperty('sketch')
  })

  it('merges both forms sketch first, the one list they mean', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { sketch: '@sk1', targets: ['entity:sk1:p1'] })
    expect(patternOf(doc).targets).toEqual(['@sk1', 'entity:sk1:p1'])
    expect(patternOf(doc)).not.toHaveProperty('sketch')
  })

  it('folds the legacy single source into the list and drops the body operation', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { subject: 'feature', source_feature: '@ex1', targets: ['@sk1'] })
    expect(patternOf(doc).source_features).toEqual(['@ex1'])
    expect(patternOf(doc)).not.toHaveProperty('source_feature')
    expect(patternOf(doc)).not.toHaveProperty('operation')
  })

  it('refuses a skip grid cell', () => {
    const cell = makeDoc()
    applyAddInstancePattern(cell, 'ip1', undefined, { targets: ['@sk1'], skip: [[1, 2]] as never })
    expect(cell.features).toHaveLength(0)
  })
})

describe('instance pattern field appliers', () => {
  it('sets a field through the setter rules', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { targets: ['@sk1'] })
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

  it('rewrites a retired sketch setter into the leading target', () => {
    const doc = makeDoc()
    applyAddInstancePattern(doc, 'ip1', undefined, { targets: ['?@ex1:flatface'] })
    applySetInstancePatternField(doc, 'ip1', 'sketch', '@sk1')
    expect(patternOf(doc)).not.toHaveProperty('sketch')
    expect(patternOf(doc).targets).toEqual(['@sk1', '?@ex1:flatface'])
    // A repeat is byte-identical: the alias always lands on the one list.
    applySetInstancePatternField(doc, 'ip1', 'sketch', '@sk1')
    expect(patternOf(doc).targets).toEqual(['@sk1', '?@ex1:flatface'])
    // A clear writes no sketch; it cannot take the row back out of the list.
    // Removing a row is the chip's own remove mutation.
    applySetInstancePatternField(doc, 'ip1', 'sketch', '')
    expect(patternOf(doc).targets).toEqual(['@sk1', '?@ex1:flatface'])
  })

  it('names the retired sketch alias in the step reply', () => {
    const add = instanceSketchAliasNote({
      type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1',
    })
    expect(add).toContain('sketch')
    expect(add).toContain('targets')
    const set = instanceSketchAliasNote({
      type: 'set_instance_pattern_field', featureId: 'ip1', field: 'sketch', value: '@sk1',
    })
    expect(set).toContain('targets')
    // Every other instance pattern write is not an alias.
    expect(instanceSketchAliasNote({
      type: 'set_instance_pattern_field', featureId: 'ip1', field: 'orientation', value: 'fixed',
    })).toBeNull()
    expect(instanceSketchAliasNote({
      type: 'add_instance_pattern', featureId: 'ip1', targets: ['@sk1'],
    })).toBeNull()
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
    // One list, with a sketch row expanding to its points; the retired
    // `sketch` key is still accepted for one release and rewritten.
    expect(add.note ?? '').toContain('a sketch row expands to its points')
    expect(add.note ?? '').toContain('`sketch` is the retired spelling')
    expect((add.fields.sketch as { note?: string }).note ?? '').toContain('targets')
    expect(mutationInfoOf('set_instance_pattern_field').fields.field.note).toContain('orientation')
  })

  it('accepts a full add payload', () => {
    const raw = {
      type: 'add_instance_pattern', featureId: 'ip1', subject: 'body',
      source_body: '@body_ex1', targets: ['@sk1'], reference: '@builtin_plane_top',
      orientation: 'normal', reverse_normal: true, skip: [2, 3],
    }
    expect(validateMutation(raw, { doc: emptyDriveDoc() })).toMatchObject({ ok: true })
  })

  it('still accepts the retired sketch key for one release', () => {
    expect(validateMutation(
      { type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1' },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
    expect(validateMutation(
      { type: 'set_instance_pattern_field', featureId: 'ip1', field: 'sketch', value: '@sk1' },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
  })
})

describe('instance pattern boundary refusals', () => {
  it('accepts both forms: they merge into the one list', () => {
    expect(validateMutation({
      type: 'add_instance_pattern', featureId: 'ip1', sketch: '@sk1', targets: ['?@ex1:flatface'],
    }, { doc: emptyDriveDoc() })).toMatchObject({ ok: true })
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

  it('takes a sketch setter beside a stored target list', () => {
    const doc = emptyDriveDoc()
    mutationHandlers.add_instance_pattern(doc, {
      type: 'add_instance_pattern', featureId: 'ip1', targets: ['?@ex1:flatface'],
    })
    expect(validateMutation(
      { type: 'set_instance_pattern_field', featureId: 'ip1', field: 'sketch', value: '@sk1' },
      { doc },
    )).toMatchObject({ ok: true })
  })

  it('refuses a setter skip with a grid cell', () => {
    expect(refusal({
      type: 'set_instance_pattern_field', featureId: 'ip1', field: 'skip', value: [[1, 2]],
    })).toContain('an instance pattern has no grid cells')
  })
})
