// The curve pattern's appliers and drive boundary, without a kernel: the
// document a bare and a full add produce, the seeded defaults, the ref-list
// chips, and the refusals that name the field and the mode that would make it
// live. The built-document half is kernel/features/__tests__/curvePatternReal.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddCurvePattern, applyAddCurvePatternPath, applyRemoveCurvePatternPath,
  applySetCurvePatternField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'
import { emptyDriveDoc } from '@/drive/headlessOps'
import { mutationInfoOf, validateMutation } from '@/drive/mutationCatalog'
import { mutationHandlers } from '@/hooks/mutationDispatch'

const makeDoc = (): PartDoc => ({ features: [] })
const curveOf = (doc: PartDoc, index = 0) => featureAt(doc, index, 'curve_pattern').curve_pattern

function refusal(raw: Record<string, unknown>): string {
  const result = validateMutation(raw, { doc: emptyDriveDoc() })
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`)
  return result.error.message
}

describe('applyAddCurvePattern', () => {
  it('inserts a curve pattern with the documented defaults and its path', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', undefined, '@sk1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({
      id: 'cv1',
      kind: 'curve_pattern',
      label: 'Curve Pattern',
      curve_pattern: { subject: 'body', operation: 'add', count: 3, path: ['@sk1'] },
    })
  })

  it('seeds the distance only in distance mode', () => {
    const equal = makeDoc()
    applyAddCurvePattern(equal, 'cv1', undefined, '@sk1')
    expect(curveOf(equal)).not.toHaveProperty('distance')

    const distance = makeDoc()
    applyAddCurvePattern(distance, 'cv2', undefined, '@sk1', { spacing: 'distance' })
    expect(curveOf(distance)).toMatchObject({ spacing: 'distance', distance: 20 })
  })

  it('keeps an authored count and clears an empty value like the setters', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', 'Run', '@sk1', { count: 6, spacing: 'equal', distance: '' } as never)
    expect(curveOf(doc)).toMatchObject({ count: 6 })
    expect(doc.features![0].label).toBe('Run')
    expect(curveOf(doc)).not.toHaveProperty('distance')
  })

  it('folds the legacy single source into the list and drops the body operation', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', undefined, '@sk1', { subject: 'feature', source_feature: '@ex1' })
    expect(curveOf(doc).source_features).toEqual(['@ex1'])
    expect(curveOf(doc)).not.toHaveProperty('source_feature')
    expect(curveOf(doc)).not.toHaveProperty('operation')
  })

  it('refuses a skip list with a grid cell', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', undefined, '@sk1', { skip: [[1, 2]] } as never)
    expect(doc.features).toHaveLength(0)
  })
})

describe('curve pattern field appliers', () => {
  it('sets a field through the setter rules', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', undefined, '@sk1')
    applySetCurvePatternField(doc, 'cv1', 'orientation', 'fixed')
    expect(curveOf(doc).orientation).toBe('fixed')
    applySetCurvePatternField(doc, 'cv1', 'count', '')
    expect(curveOf(doc)).not.toHaveProperty('count')
  })

  it('toggles and removes a path ref', () => {
    const doc = makeDoc()
    applyAddCurvePattern(doc, 'cv1', undefined, '@sk1')
    applyAddCurvePatternPath(doc, 'cv1', '@sk2')
    expect(curveOf(doc).path).toEqual(['@sk1', '@sk2'])
    applyAddCurvePatternPath(doc, 'cv1', '@sk2')
    expect(curveOf(doc).path).toEqual(['@sk1'])
    applyRemoveCurvePatternPath(doc, 'cv1', 0)
    expect(curveOf(doc).path).toEqual([])
  })
})

describe('the curve pattern mutation catalog', () => {
  it('lists the add, the setter and the two path chips', () => {
    for (const type of ['add_curve_pattern', 'set_curve_pattern_field', 'add_curve_pattern_path', 'remove_curve_pattern_path'] as const) {
      expect(mutationInfoOf(type).summary.length, type).toBeGreaterThan(0)
    }
    const add = mutationInfoOf('add_curve_pattern')
    for (const field of ['pathQuery', 'count', 'spacing', 'distance', 'reverse', 'orientation', 'normal_ref', 'skip']) {
      expect(add.fields[field], field).toBeDefined()
    }
    // No centered option on a path: the field is absent, so the boundary
    // refuses it by name.
    expect(add.fields.centered).toBeUndefined()
    expect(add.note ?? '').toContain('NO `centered`')
    expect(add.note ?? '').toContain('rotation-minimizing')
    expect(mutationInfoOf('set_curve_pattern_field').fields.field.note).toContain('spacing')
  })

  it('accepts a full add payload', () => {
    const raw = {
      type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', subject: 'body',
      source_body: '@body_ex1', count: 4, spacing: 'distance', distance: 12.5,
      orientation: 'normal_to', normal_ref: '@builtin_plane_top', reverse: true, skip: [2],
    }
    expect(validateMutation(raw, { doc: emptyDriveDoc() })).toMatchObject({ ok: true })
  })
})

describe('curve pattern boundary refusals', () => {
  it('refuses a centered field by name', () => {
    expect(refusal({ type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', centered: true }))
      .toContain('has no field "centered"')
  })

  it('refuses a distance outside distance mode', () => {
    expect(refusal({ type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', distance: 10 }))
      .toContain('read only when spacing is "distance"')
  })

  it('refuses a normal_ref outside normal_to', () => {
    expect(refusal({
      type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', normal_ref: '@builtin_plane_top',
    })).toContain('read only when orientation is "normal_to"')
  })

  it('refuses a grid cell but reads a row-0 cell as the 1D index it means', () => {
    expect(refusal({ type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', skip: [[1, 2]] }))
      .toContain('whole instance numbers')
    // A row-0 cell is the same entry as the bare index, the shared parser's rule.
    expect(validateMutation(
      { type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', skip: [[1, 0]] },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
    expect(refusal({ type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1', skip: [0] }))
      .toContain('skip')
  })

  it('refuses a non-positive distance even in distance mode', () => {
    expect(refusal({
      type: 'set_curve_pattern_field', featureId: 'cv1', field: 'distance', value: -5,
    })).toContain('distance')
  })

  it('judges a setter against the stored mode', () => {
    // A stored equal-spacing pattern cannot take a distance: the value would be
    // ignored by the solve.
    const doc = emptyDriveDoc()
    mutationHandlers.add_curve_pattern(doc, { type: 'add_curve_pattern', featureId: 'cv1', pathQuery: '@sk1' })
    const result = validateMutation(
      { type: 'set_curve_pattern_field', featureId: 'cv1', field: 'distance', value: 10 },
      { doc },
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error.message).toContain('read only when spacing is "distance"')
  })
})
