// The two pattern editor schemas: the source is chosen as one or more feature
// rows from the document (not a viewport pick), the linear rows show one
// direction plus the second when it is on, and the circular rows show the axis
// and the angle law.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import {
  CIRCULAR_PATTERN_SCHEMA, EDITOR_SCHEMAS, LINEAR_PATTERN_SCHEMA, PATTERN_SOURCE_FIELDS,
} from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import type { NumberFieldDef, PickFieldDef, TextFieldDef } from '@/components/editors/widgets/fieldTypes'
import { validateNumberFieldValue } from '@/components/editors/widgets/numberFieldValidate'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  { id: 'rv1', kind: 'revolve', label: 'Revolve 1', revolve: { sketch: [], angle: 90 } },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1', entities: [], initial: {} },
  // The editor rows from here on are at or after the edited pattern: neither is
  // a legal source, and the order rule must refuse them.
  { id: 'pt1', kind: 'linear_pattern', label: 'Pattern', linear_pattern: {} },
  { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: [], distance: 1 } },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind: 'linear_pattern',
    label: 'Pattern',
    linear_pattern: {
      subject: 'feature', source_features: [], count: 2, pitch: 20, ...over,
    },
  } as unknown as PartFeature
}

function makeCircular(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind: 'circular_pattern',
    label: 'Pattern',
    circular_pattern: { subject: 'feature', source_features: [], count: 4, ...over },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation = vi.fn(), solved?: Record<string, unknown>) {
  render(
    <FeatureEditor
      feature={feature}
      onMutation={onMutation}
      features={FEATURES}
      schema={LINEAR_PATTERN_SCHEMA}
      solved={solved}
    />,
  )
  return onMutation
}

const labelsNow = () => [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)

const field = (key: string) => {
  const found = LINEAR_PATTERN_SCHEMA.fields.find((f) => f.key === key)
  if (found === undefined) throw new Error(`no ${key} field`)
  return found
}

describe('LINEAR_PATTERN_SCHEMA', () => {
  it('is registered with its sub-key, defaults and field order', () => {
    expect(EDITOR_SCHEMAS.linear_pattern).toBe(LINEAR_PATTERN_SCHEMA)
    expect(LINEAR_PATTERN_SCHEMA.subKey).toBe('linear_pattern')
    expect(LINEAR_PATTERN_SCHEMA.defaults).toEqual({
      subject: 'body', operation: 'add', count: 2, pitch: 20, source_features: [],
    })
    expect(LINEAR_PATTERN_SCHEMA.fields.map((f) => f.key)).toEqual([
      'subject', 'source_body', 'source_features', 'target_body', 'operation',
      'direction_mode', 'direction_query', 'invert', 'count', 'pitch',
      'resolved_pitch', 'direction', 'direction', 'direction',
      'centered', 'second_direction',
      'direction_2_mode', 'direction_2_query', 'invert_2', 'count_2', 'pitch_2',
      'resolved_pitch_2', 'direction_2', 'direction_2', 'direction_2',
      'centered_2', 'skip',
    ])
  })

  it('shares the source rows with the circular schema', () => {
    expect(CIRCULAR_PATTERN_SCHEMA.fields.slice(0, PATTERN_SOURCE_FIELDS.length)).toEqual(PATTERN_SOURCE_FIELDS)
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
    expect(LINEAR_PATTERN_SCHEMA.fields.some((f) => f.key === 'include_source')).toBe(false)
  })

  it('shows Skip Instances as the formatted list and the live instance total', () => {
    renderEditor(makeFeature({ count: 4, skip: [2] }))
    const skip = LINEAR_PATTERN_SCHEMA.fields.find((f) => f.key === 'skip') as TextFieldDef
    expect(skip.format!(undefined)).toBe('')
    expect(skip.format!([2, -1, [2, -3]])).toBe('-1, 2:-3, 2')
    const row = screen.getByText('Skip Instances').parentElement!
    expect((row.querySelector('input') as HTMLInputElement).value).toBe('2')
    // Four instances in all, two copies left after the skipped one.
    expect(screen.getByText('4 instances, 2 new, 1 skipped')).not.toBeNull()
  })

  it('refuses skip text the parser cannot read and dispatches nothing', () => {
    const onMutation = renderEditor(makeFeature({ count: 4 }))
    const input = screen.getByText('Skip Instances').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '3-5' } })
    expect(screen.getByText(/ranges are not supported/)).not.toBeNull()
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('dispatches the parsed skip list when the text is valid', () => {
    const onMutation = renderEditor(makeFeature({ count: 4 }))
    const input = screen.getByText('Skip Instances').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '1, 3' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_linear_pattern_field', featureId: 'pt1', field: 'skip', value: [1, 3],
    })
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

  it('hides the second-direction rows until the checkbox is ticked', () => {
    renderEditor(makeFeature())
    const labels = labelsNow()
    expect(labels).toContain('Direction')
    expect(labels).toContain('Pitch')
    expect(labels).not.toContain('Direction 2')
    expect(labels).not.toContain('Direction 2 type')
    expect(labels).not.toContain('Count 2')
    expect(labels).not.toContain('Pitch 2')
    expect(labels).not.toContain('Centered 2')
  })

  it('shows the second-direction rows when the checkbox is ticked', () => {
    renderEditor(makeFeature({ second_direction: true }))
    const labels = labelsNow()
    expect(labels).toContain('Direction 2 type')
    expect(labels).toContain('Direction 2')
    expect(labels).toContain('Invert 2')
    expect(labels).toContain('Count 2')
    expect(labels).toContain('Pitch 2')
    expect(labels).toContain('Centered 2')
  })

  it('offers the three direction types and defaults to Direction + Distance', () => {
    renderEditor(makeFeature())
    const labels = labelsNow()
    expect(labels).toContain('Direction type')
    expect(labels).not.toContain('Spacing')
    expect(labels).not.toContain('Step X')
    const select = field('direction_mode')
    expect(select.type).toBe('select')
    expect(select.type === 'select' && select.options.map((o) => o.value))
      .toEqual(['direction_distance', 'directive_length', 'manual'])
    expect(select.type === 'select' && select.default).toBe('direction_distance')
  })

  it('replaces Pitch with the resolved Spacing row in directive-length mode', () => {
    renderEditor(makeFeature({ direction_mode: 'directive_length' }), vi.fn(), { resolved_pitch: 15 })
    const labels = labelsNow()
    expect(labels).toContain('Spacing')
    expect(labels).not.toContain('Pitch')
    expect(screen.getByText('15', { exact: false })).not.toBeNull()
  })

  it('hides the Spacing row until a solve has reported one', () => {
    renderEditor(makeFeature({ direction_mode: 'directive_length' }))
    expect(labelsNow()).not.toContain('Spacing')
  })

  it('shows the manual step rows and writes the whole vector', () => {
    const onMutation = renderEditor(makeFeature({ direction_mode: 'manual', direction: [2, 0, 5] }))
    const labels = labelsNow()
    expect(labels).toContain('Step X')
    expect(labels).toContain('Step Y')
    expect(labels).toContain('Step Z')
    expect(labels).not.toContain('Direction')
    expect(labels).not.toContain('Pitch')
    const x = screen.getByText('Step X').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.focus(x)
    fireEvent.change(x, { target: { value: '10' } })
    fireEvent.blur(x)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_linear_pattern_field', featureId: 'pt1', field: 'direction', value: [10, 0, 5],
    })
  })

  it('refuses a pick without a length only in directive-length mode', () => {
    const pick = field('direction_query') as PickFieldDef
    expect(pick.validatePick!('face:ex1:?4;@ex1:flatface', FEATURES, { direction_mode: 'directive_length' }))
      .toContain('needs a pick with a length')
    expect(pick.validatePick!('edge:ex1:?4;@ex1:edge', FEATURES, { direction_mode: 'directive_length' }))
      .toContain('a circle has none')
    expect(pick.validatePick!('edge:ex1:?4;@ex1:straightedge', FEATURES, { direction_mode: 'directive_length' }))
      .toBeNull()
    expect(pick.validatePick!('face:ex1:?4;@ex1:cylinderface', FEATURES, { direction_mode: 'directive_length' }))
      .toBeNull()
    // A sketch entity pick carries no type restriction: the kernel reads a
    // line's length and refuses a circle itself.
    expect(pick.validatePick!('entity:sk1:l1', FEATURES, { direction_mode: 'directive_length' }))
      .toBeNull()
    // The same face is a fine direction pick when the mode reads a direction.
    expect(pick.validatePick!('face:ex1:?4;@ex1:flatface', FEATURES, { direction_mode: 'direction_distance' }))
      .toBeNull()
  })

  it('judges the count as the loader does', () => {
    const count = field('count') as NumberFieldDef
    expect(count.validateWith!(0, {})).toContain('whole number of at least 1')
    expect(count.validateWith!(2.5, {})).toContain('whole number')
    expect(count.validateWith!(2, {})).toBeNull()
  })

  it('accepts count 1, the quiet no-op', () => {
    // The field has no min, so the pattern's own rule is what the widget sees.
    expect(validateNumberFieldValue(field('count') as NumberFieldDef, 1, {})).toBeNull()
  })
})

describe('CIRCULAR_PATTERN_SCHEMA', () => {
  it('is registered with its sub-key and defaults', () => {
    expect(EDITOR_SCHEMAS.circular_pattern).toBe(CIRCULAR_PATTERN_SCHEMA)
    expect(CIRCULAR_PATTERN_SCHEMA.subKey).toBe('circular_pattern')
    expect(CIRCULAR_PATTERN_SCHEMA.defaults).toEqual({
      subject: 'body', operation: 'add', count: 4, angle: 360, equal_spacing: true, source_features: [],
    })
  })

  it('shows the axis, count and angle rows and none of the linear direction rows', () => {
    render(<FeatureEditor feature={makeCircular()} onMutation={vi.fn()} features={FEATURES} schema={CIRCULAR_PATTERN_SCHEMA} />)
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).toContain('Axis')
    expect(labels).toContain('Invert axis')
    expect(labels).toContain('Count')
    expect(labels).toContain('Angle')
    expect(labels).toContain('Equal spacing')
    expect(labels).toContain('Centered')
    expect(labels).toContain('Skip Instances')
    expect(labels).not.toContain('Direction')
    expect(labels).not.toContain('Pitch')
    expect(labels).not.toContain('Second direction')
  })

  it('dispatches a circular setter mutation', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeCircular()} onMutation={onMutation} features={FEATURES} schema={CIRCULAR_PATTERN_SCHEMA} />)
    const angle = screen.getByText('Angle').parentElement!.querySelector('input') as HTMLInputElement
    fireEvent.focus(angle)
    fireEvent.change(angle, { target: { value: '180' } })
    fireEvent.blur(angle)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'angle', value: 180,
    })
  })
})
