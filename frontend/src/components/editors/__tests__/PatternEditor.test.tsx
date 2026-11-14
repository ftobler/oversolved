// The pattern editor schema: the source is chosen as one or more feature rows
// from the document (not a viewport pick), the linear fields show the direction
// and pitch, and the circular fields show the axis and step.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { PATTERN_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import type { NumberFieldDef, PickFieldDef } from '@/components/editors/widgets/fieldTypes'
import { validateNumberFieldValue } from '@/components/editors/widgets/numberFieldValidate'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  { id: 'rv1', kind: 'revolve', label: 'Revolve 1', revolve: { sketch: [], angle: 90 } },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1', entities: [], initial: {} },
  // The editor rows from here on are at or after the edited pattern: neither is
  // a legal source, and the order rule must refuse them.
  { id: 'pt1', kind: 'pattern', label: 'Pattern', pattern: {} },
  { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: [], distance: 1 } },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind: 'pattern',
    label: 'Pattern',
    pattern: {
      subject: 'feature', source_features: [], mode: 'linear', count: 2, pitch: 20, ...over,
    },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation = vi.fn()) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={PATTERN_SCHEMA} />)
  return onMutation
}

const field = (key: string) => {
  const found = PATTERN_SCHEMA.fields.find((f) => f.key === key)
  if (found === undefined) throw new Error(`no ${key} field`)
  return found
}

describe('PATTERN_SCHEMA', () => {
  it('is registered with its sub-key, defaults and field order', () => {
    expect(EDITOR_SCHEMAS.pattern).toBe(PATTERN_SCHEMA)
    expect(PATTERN_SCHEMA.subKey).toBe('pattern')
    expect(PATTERN_SCHEMA.defaults).toEqual({
      subject: 'body', mode: 'linear', operation: 'add', count: 2, pitch: 20, source_features: [],
    })
    expect(PATTERN_SCHEMA.fields.map((f) => f.key)).toEqual([
      'subject', 'source_body', 'source_features', 'target_body', 'operation',
      'mode', 'count', 'direction_query', 'invert', 'pitch',
      'direction_x_query', 'invert_x', 'count_x', 'pitch_x',
      'direction_y_query', 'invert_y', 'count_y', 'pitch_y',
      '_evenly_spaced', 'step_angle', 'axis', 'invert_axis',
    ])
  })

  it('is a multi pick chip, not a dropdown', () => {
    const source = field('source_features') as PickFieldDef
    expect(source.type).toBe('pick')
    expect(source.multi).toBe(true)
    expect(source.addMutationType).toBe('add_pattern_source')
    expect(source.addValueKey).toBe('sourceFeature')
    expect(source.removeMutationType).toBe('remove_pattern_source')
  })

  it('does not offer the retired include-source option', () => {
    renderEditor(makeFeature({ subject: 'body' }))
    expect(screen.queryByText('Include src')).toBeNull()
    expect(PATTERN_SCHEMA.fields.some((f) => f.key === 'include_source')).toBe(false)
  })

  it('refuses a source that is not an earlier extrude, revolve or sweep', () => {
    const source = field('source_features') as PickFieldDef
    expect(source.validatePick!('@ex1', FEATURES)).toBeNull()
    expect(source.validatePick!('@rv1', FEATURES)).toBeNull()
    expect(source.validatePick!('@sk1', FEATURES)).toContain('extrude, revolve or sweep')
    expect(source.validatePick!('@body_ex1', FEATURES)).toContain('feature row')
    expect(source.validatePick!('@ex1/face/0', FEATURES)).toContain('feature row')
  })

  it('shows every source as its own chip', () => {
    renderEditor(makeFeature({ source_features: ['@ex1', '@rv1'] }))
    expect(screen.getByText('Extrude 1')).not.toBeNull()
    expect(screen.getByText('Revolve 1')).not.toBeNull()
  })

  it('adds a picked feature through the pattern source mutation', () => {
    const onMutation = renderEditor(makeFeature({ source_features: ['@ex1'] }))
    fireEvent.click(screen.getByText('Extrude 1'))
    act(() => {
      useSketchEditorStore.setState({ normalSelection: new Set(['@rv1']) })
    })
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_pattern_source', featureId: 'pt1', sourceFeature: '@rv1',
    })
  })

  it('removes a chip through the pattern source mutation', () => {
    const onMutation = renderEditor(makeFeature({ source_features: ['@ex1', '@rv1'] }))
    const removes = document.querySelectorAll('.feature-pick-chip-item-remove')
    fireEvent.click(removes[1])
    expect(onMutation).toHaveBeenCalledWith({
      type: 'remove_pattern_source', featureId: 'pt1', index: 1,
    })
  })

  it('shows a legacy single source as one chip', () => {
    // A row written before the source became a list names source_feature and no
    // source_features; it must render its source, not an empty chip.
    renderEditor(makeFeature({ subject: undefined, source_features: undefined, source_feature: '@ex1' }))
    expect(screen.getByText('Extrude 1')).not.toBeNull()
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).toContain('Source Features')
    expect(labels).not.toContain('Body')
  })

  it('hides the body source when the subject is a feature', () => {
    renderEditor(makeFeature({ subject: 'feature' }))
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).not.toContain('Body')
    expect(labels).not.toContain('Operation')
    expect(labels).toContain('Source Features')
  })

  it('shows the linear fields in linear mode and the circular fields in circular mode', () => {
    renderEditor(makeFeature())
    expect(screen.queryByText('Direction')).not.toBeNull()
    expect(screen.queryByText('Pitch')).not.toBeNull()
    expect(screen.queryByText('Axis')).toBeNull()
    expect(screen.queryByText('Step angle')).toBeNull()
  })

  it('shows the axis fields in circular mode and hides the linear pair', () => {
    renderEditor(makeFeature({ mode: 'circular' }))
    expect(screen.queryByText('Axis')).not.toBeNull()
    expect(screen.queryByText('Invert axis')).not.toBeNull()
    expect(screen.queryByText('Direction')).toBeNull()
    expect(screen.queryByText('Pitch')).toBeNull()
  })

  it('judges the count as the loader does', () => {
    const count = field('count') as NumberFieldDef
    expect(count.validateWith!(0, {})).toContain('includes the source')
    expect(count.validateWith!(1, {})).toContain('includes the source')
    expect(count.validateWith!(2.5, {})).toContain('integer')
    expect(count.validateWith!(2, {})).toBeNull()
  })

  it('shows the source-in-count reason when count 1 is typed', () => {
    // The field has no min, so the pattern's own rule is what the widget sees
    // rather than a bare "must be at least 2".
    expect(validateNumberFieldValue(field('count') as NumberFieldDef, 1, {})).toContain('includes the source')
  })
})
