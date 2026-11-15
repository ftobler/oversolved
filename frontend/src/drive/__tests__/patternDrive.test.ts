// @vitest-environment node
//
// The pattern drive surface without a kernel: the catalog rows, their notes (the
// total-count convention, the second direction, the circular angle law), the
// document an inline add produces, the boundary refusals with their fixes, and
// the one-release `add_pattern` alias. The built-document half is
// patternDriveReal.test.ts.

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
  it('lists both kinds and their setters, each stating the count convention', () => {
    for (const type of [
      'add_linear_pattern', 'set_linear_pattern_field',
      'add_circular_pattern', 'set_circular_pattern_field',
    ] as const) {
      const info = mutationInfoOf(type)
      expect(info.summary.length).toBeGreaterThan(0)
      expect(info.note ?? '', type).toContain('TOTAL instance count')
    }
    expect(mutationInfoOf('add_linear_pattern').note ?? '').toContain('second_direction')
    expect(mutationInfoOf('add_circular_pattern').note ?? '').toContain('equal_spacing')
  })

  it('publishes the inline fields and both setters', () => {
    const add = mutationInfoOf('add_linear_pattern')
    for (const field of ['source_features', 'source_feature', 'count', 'pitch', 'direction', 'second_direction', 'count_2', 'pitch_2']) {
      expect(add.fields[field], field).toBeDefined()
    }
    const circular = mutationInfoOf('add_circular_pattern')
    for (const field of ['count', 'angle', 'equal_spacing', 'axis', 'axis_origin', 'axis_direction']) {
      expect(circular.fields[field], field).toBeDefined()
    }
    expect(mutationInfoOf('set_linear_pattern_field').fields.field.note).toContain('source_features')
    expect(mutationInfoOf('set_circular_pattern_field').fields.field.note).toContain('angle')
    expect(PART_DOC_SCHEMA_JSON).toContain('"linear_pattern"')
    expect(PART_DOC_SCHEMA_JSON).toContain('"circular_pattern"')
  })

  it('marks the retired add_pattern row deprecated and points at the two kinds', () => {
    const info = mutationInfoOf('add_pattern')
    expect(info.deprecated).toBeDefined()
    expect(info.deprecated).toContain('Deprecated')
    expect(info.deprecated).toContain('add_linear_pattern')
    expect(info.note ?? '').toContain('add_linear_pattern')
  })
})

describe('pattern boundary refusals', () => {
  it('refuses a sketch-local source ref', () => {
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', source_feature: '$ex1' })).toContain('"$"')
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', source_features: ['$ex1'] })).toContain('"$"')
    expect(refusal({ type: 'add_circular_pattern', featureId: 'pt1', source_features: ['$ex1'] })).toContain('"$"')
  })

  it('refuses a malformed direction and a non-list value', () => {
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', direction: [1] })).toContain('direction')
    expect(refusal({ type: 'set_linear_pattern_field', featureId: 'pt1', field: 'count', value: {} })).toContain('count')
  })

  it('refuses an unknown setter field by name', () => {
    expect(refusal({ type: 'set_linear_pattern_field', featureId: 'pt1', field: 'spacing', value: 5 })).toContain('spacing')
  })

  it('refuses the retired include_source field as unknown', () => {
    expect(refusal({
      type: 'set_linear_pattern_field', featureId: 'pt1', field: 'include_source', value: false,
    })).toContain('include_source')
  })

  it('refuses count 0 and a non-integer count, but accepts count 1', () => {
    for (const [type, field] of [
      ['set_linear_pattern_field', 'count'],
      ['set_circular_pattern_field', 'count'],
    ] as const) {
      for (const value of [0, 2.5]) {
        expect(refusal({ type, featureId: 'pt1', field, value })).toContain('whole number of at least 1')
        expect(refusal({ type: type === 'set_linear_pattern_field' ? 'add_linear_pattern' : 'add_circular_pattern', featureId: 'pt1', count: value }))
          .toContain('whole number of at least 1')
      }
    }
    for (const value of [1, '1']) {
      const accepted = validateMutation(
        { type: 'add_linear_pattern', featureId: 'pt1', count: value },
        { doc: emptyDriveDoc() },
      )
      expect(accepted.ok, String(value)).toBe(true)
    }
  })

  it('accepts a 1x1 second-direction pair, the same quiet no-op as count 1', () => {
    const accepted = validateMutation(
      { type: 'add_linear_pattern', featureId: 'pt1', second_direction: true, count: 1, count_2: 1 },
      { doc: emptyDriveDoc() },
    )
    expect(accepted.ok).toBe(true)
  })

  it('accepts Skip Instances as text or as a list and refuses a zero or a range', () => {
    for (const skip of ['1, 2, 6, 7', '2:-1', [1, 2, [3, -1]]]) {
      const accepted = validateMutation(
        { type: 'add_linear_pattern', featureId: 'pt1', skip },
        { doc: emptyDriveDoc() },
      )
      expect(accepted.ok, JSON.stringify(skip)).toBe(true)
    }
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', skip: '0' }))
      .toContain('instance 0 is the original')
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', skip: '3-5' }))
      .toContain('ranges are not supported')
    expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', skip: [0] }))
      .toContain('instance 0 is the original')
    expect(refusal({ type: 'set_linear_pattern_field', featureId: 'pt1', field: 'skip', value: '3-5' }))
      .toContain('ranges are not supported')
  })

  it('refuses a grid cell in a circular skip list', () => {
    expect(refusal({ type: 'add_circular_pattern', featureId: 'pt1', skip: [[2, -1]] }))
      .toContain('no grid cells')
    expect(refusal({ type: 'set_circular_pattern_field', featureId: 'pt1', field: 'skip', value: '2:-1' }))
      .toContain('no grid cells')
  })

  it('accepts the three direction modes and a vector with expression components', () => {
    for (const mode of ['direction_distance', 'directive_length', 'manual']) {
      const accepted = validateMutation(
        { type: 'add_linear_pattern', featureId: 'pt1', direction_mode: mode, direction_2_mode: mode },
        { doc: emptyDriveDoc() },
      )
      expect(accepted.ok, mode).toBe(true)
    }
    const vector = validateMutation(
      {
        type: 'add_linear_pattern', featureId: 'pt1', direction_mode: 'manual',
        direction: ['w/2', 0, 5],
      },
      { doc: emptyDriveDoc() },
    )
    expect(vector.ok, JSON.stringify(!vector.ok ? vector.error : null)).toBe(true)
    const unknown = refusal({ type: 'add_linear_pattern', featureId: 'pt1', direction_mode: 'sideways' })
    expect(unknown).toContain('direction_distance')
    expect(unknown).toContain('sideways')
  })

  it('refuses pitch in a mode that does not read it, by name', () => {
    for (const mode of ['directive_length', 'manual']) {
      expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', direction_mode: mode, pitch: 5 }))
        .toContain(`pitch is not read in ${mode} mode`)
      expect(refusal({ type: 'add_linear_pattern', featureId: 'pt1', direction_2_mode: mode, pitch_2: 5 }))
        .toContain(`pitch_2 is not read in ${mode} mode`)
    }
    // A mode that does read it takes one, and a manual step needs no pitch.
    expect(validateMutation(
      { type: 'add_linear_pattern', featureId: 'pt1', direction_mode: 'direction_distance', pitch: 5 },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
    expect(validateMutation(
      {
        type: 'add_linear_pattern', featureId: 'pt1', second_direction: true,
        direction_mode: 'direction_distance', direction_2_mode: 'direction_distance',
        pitch: 5, pitch_2: 5,
      },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
    expect(validateMutation(
      { type: 'add_linear_pattern', featureId: 'pt1', direction_mode: 'manual', direction: [10, 0, 0] },
      { doc: emptyDriveDoc() },
    )).toMatchObject({ ok: true })
  })

  it('refuses a setter pitch against the MODE STORED on the document', () => {
    const doc: PartDoc = emptyDriveDoc()
    doc.features = [{
      id: 'pt1', kind: 'linear_pattern',
      linear_pattern: { subject: 'body', source_body: '@b1', direction_mode: 'manual', direction: [5, 0, 0] },
    }]
    const result = validateMutation(
      { type: 'set_linear_pattern_field', featureId: 'pt1', field: 'pitch', value: 5 },
      { doc },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('pitch is not read in manual mode')
    // The same setter lands once the mode reads a pitch.
    const ok = validateMutation(
      { type: 'set_linear_pattern_field', featureId: 'pt1', field: 'direction_mode', value: 'direction_distance' },
      { doc },
    )
    expect(ok).toMatchObject({ ok: true })
  })
})

describe('one inline add lands the whole pattern', () => {
  it('stores the source list, count, pitch and direction in one call', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_linear_pattern(doc, {
      type: 'add_linear_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
      source_features: ['@ex1', '@ex2'], count: 4, pitch: 8,
      direction: [1, 0, 0], invert: true, target_body: '@body_ex1',
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'linear_pattern',
      linear_pattern: {
        subject: 'feature', source_features: ['@ex1', '@ex2'], count: 4, pitch: 8,
        direction: [1, 0, 0], invert: true, target_body: '@body_ex1',
      },
    })
  })

  it('lands a manual direction mode and its step vector in one call', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_linear_pattern(doc, {
      type: 'add_linear_pattern', featureId: 'pt1', label: 'Pattern', subject: 'body',
      source_body: '@b1', count: 2, direction_mode: 'manual', direction: [10, 0, 5],
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      linear_pattern: { direction_mode: 'manual', direction: [10, 0, 5] },
    })
  })

  it('keeps the legacy single source working and lands a one-element list', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_circular_pattern(doc, {
      type: 'add_circular_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
      source_feature: '@ex1', count: 3,
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({ circular_pattern: { source_features: ['@ex1'] } })
    expect((feature as { circular_pattern: Record<string, unknown> }).circular_pattern.source_feature).toBeUndefined()
  })
})

describe('the deprecated add_pattern alias', () => {
  it('lands the linear kind through the loader split', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_pattern(doc, {
      type: 'add_pattern', featureId: 'pt1', label: 'Pattern', subject: 'feature',
      source_features: ['@ex1'], count: 3, pitch: 8, direction: [1, 0, 0],
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'linear_pattern',
      linear_pattern: { subject: 'feature', source_features: ['@ex1'], count: 3, pitch: 8, direction: [1, 0, 0] },
    })
  })

  it('lands the circular kind and the angle law', () => {
    const doc: PartDoc = emptyDriveDoc()
    mutationHandlers.add_pattern(doc, {
      type: 'add_pattern', featureId: 'pt1', mode: 'circular', count: 4, step_angle: 30,
    })
    const feature = doc.features?.find((entry) => entry.id === 'pt1')
    expect(feature).toMatchObject({
      kind: 'circular_pattern',
      circular_pattern: { angle: 30, equal_spacing: false },
    })
  })

  it('is still validated at the boundary and lists its note', () => {
    const accepted = validateMutation(
      { type: 'add_pattern', featureId: 'pt1', mode: 'rectangular', count_x: 2, count_y: 2 },
      { doc: emptyDriveDoc() },
    )
    expect(accepted.ok).toBe(true)
    expect(refusal({ type: 'add_pattern', featureId: 'pt1', mode: 'polar' })).toContain('"rectangular"')
  })
})
