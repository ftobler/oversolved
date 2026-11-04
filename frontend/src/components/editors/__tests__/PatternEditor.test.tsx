// The pattern editor schema: the source is chosen from the document's own
// extrude/revolve/sweep rows (not from a viewport pick), the linear fields show
// the direction and pitch, and the circular fields show the axis and step.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { PATTERN_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { PartFeature } from '@/types/cad'
import type { NumberFieldDef } from '@/components/editors/widgets/fieldTypes'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  { id: 'rv1', kind: 'revolve', label: 'Revolve 1', revolve: { sketch: [], angle: 90 } },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1', entities: [], initial: {} },
  // The editor rows from here on are at or after the edited pattern: neither is
  // a legal source, and the options must not offer them.
  { id: 'pt1', kind: 'pattern', label: 'Pattern', pattern: {} },
  { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: [], distance: 1 } },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind: 'pattern',
    label: 'Pattern',
    pattern: {
      subject: 'feature', source_feature: '', mode: 'linear', count: 2, pitch: 20, ...over,
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
      subject: 'body', mode: 'linear', operation: 'add', include_source: true, count: 2, pitch: 20,
    })
    expect(PATTERN_SCHEMA.fields.map((f) => f.key)).toEqual([
      'subject', 'source_body', 'source_feature', 'target_body', 'operation', 'include_source',
      'mode', 'count', 'direction_query', 'invert', 'pitch',
      'direction_x_query', 'invert_x', 'count_x', 'pitch_x',
      'direction_y_query', 'invert_y', 'count_y', 'pitch_y',
      '_evenly_spaced', 'step_angle', 'axis', 'invert_axis',
    ])
  })

  it('offers only the repeatable feature kinds as the source, excluding itself', () => {
    renderEditor(makeFeature({ subject: 'feature' }))
    const select = screen.getByLabelText('Source Feature') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', '@ex1', '@rv1'])
  })

  it('writes the source feature id with the sigil', () => {
    const onMutation = renderEditor(makeFeature({ subject: 'feature' }))
    const select = screen.getByLabelText('Source Feature') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '@ex1' } })
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'source_feature', value: '@ex1',
    })
  })

  it('hides the body source when the subject is a feature', () => {
    renderEditor(makeFeature({ subject: 'feature' }))
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).not.toContain('Body')
    expect(labels).not.toContain('Operation')
    expect(labels).toContain('Source Feature')
  })

  it('shows a legacy feature pattern with its inferred feature subject', () => {
    // A row written before the subject field names source_feature and no
    // source_body; it must not render as a body pattern asking for a body.
    renderEditor(makeFeature({ subject: undefined, source_feature: '@ex1' }))
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).toContain('Source Feature')
    expect(labels).not.toContain('Body')
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
    expect(count.validateWith!(0, {})).toContain('>= 1')
    expect(count.validateWith!(2.5, {})).toContain('integer')
    expect(count.validateWith!(1, {})).toBeNull()
  })
})
