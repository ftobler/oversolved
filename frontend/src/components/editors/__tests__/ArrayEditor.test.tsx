/**
 * The body subject's source body and direction are pickable. The solver
 * honours `pattern.source_body` and `pattern.direction_query` /
 * `direction_x_query` / `direction_y_query`; the editor exposes chips for each
 * so a multi-body document can be patterned on the intended body, along the
 * intended edge or face.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { PATTERN_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  { id: 'pt1', kind: 'pattern', pattern: { subject: 'body' } },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind: 'pattern',
    label: 'Pattern',
    pattern: {
      subject: 'body', mode: 'linear', count: 2, pitch: 20, direction: [1, 0, 0],
      operation: 'add', include_source: true, source_body: '', ...over,
    },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation: () => void) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={PATTERN_SCHEMA} />)
}

/** All pick chips in schema field order. Linear mode: [0] Body, [1] Direction. */
function chips(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('.feature-pick-chip')
}
const bodyChip = () => chips()[0]
const dirChip = () => chips()[1]

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

beforeEach(() => {
  useEditorState.setState({
    // modeStack rides with activePickField: clearing the field alone would leave
    // the previous test's 'pick' entry for the next one to stack onto.
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
})

describe('body pattern source body pick (via FeatureEditor)', () => {
  it('renders an empty body chip asking for the body to copy', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = bodyChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick the body to copy)')
  })

  it('renders the source_body ref when set', () => {
    renderEditor(makeFeature({ source_body: '@body_ex1' }), vi.fn())
    expect(bodyChip().querySelector('.feature-pick-chip-item-text')?.textContent).toBe('body_ex1')
  })

  it('picking a body normalizes to an @body_ ref', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('body:body_ex1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'source_body', value: '@body_ex1',
    })
  })

  it('picking a face of a body keeps the inner query for the solver to resolve', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('face:ex1:?4;@ex1:face')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'source_body', value: '?4;@ex1:face',
    })
  })

  it('rejects picking the pattern\'s own body', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('@body_pt1')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('remove button clears source_body back to the empty pick', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature({ source_body: '@body_ex1' }), onMutation)
    fireEvent.click(bodyChip().querySelector('.feature-pick-chip-item-remove')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'source_body', value: '',
    })
  })
})

describe('body pattern count fields honour parse: \'int\'', () => {
  // Type `text` into the labelled field and blur, which is the commit path.
  function typeAndBlur(label: string, text: string) {
    const input = screen.getByRole('textbox', { name: label }) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: text } })
    fireEvent.blur(input)
    return input
  }

  it('rejects a fractional Count and reverts to the stored value', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    const input = typeAndBlur('Count', '2.5')
    expect(onMutation).not.toHaveBeenCalled()
    expect(input.value).toBe('2')
  })

  it('rejects an expression evaluating to a fraction', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    typeAndBlur('Count', '5/2')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('still commits a whole Count', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    typeAndBlur('Count', '4')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'count', value: 4,
    })
  })

  it('leaves the float Pitch field accepting fractions', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    typeAndBlur('Pitch', '12.5')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'pitch', value: 12.5,
    })
  })
})

describe('body pattern direction pick (via FeatureEditor)', () => {
  it('renders an empty direction chip flagged as a required pick', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = dirChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick edge or face, required)')
  })

  it('picking an edge stores its inner query as direction_query', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(dirChip())
    pick('edge:ex1:?4;@ex1:edge')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'direction_query', value: '?4;@ex1:edge',
    })
  })

  it('toggling Invert dispatches an invert field mutation', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    const rows = [...document.querySelectorAll<HTMLElement>('.feature-field-row')]
    const invertRow = rows.find((r) => r.querySelector('.feature-field-label')?.textContent === 'Invert')!
    fireEvent.click(invertRow.querySelector('input[type="checkbox"]')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'invert', value: true,
    })
  })

  it('hides the Invert Y toggle in linear mode', () => {
    renderEditor(makeFeature(), vi.fn())
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).toContain('Invert')
    expect(labels).not.toContain('Invert Y')
  })

  it('hides the Direction Y chip in linear mode', () => {
    renderEditor(makeFeature(), vi.fn())
    // Linear mode: only Body + Direction chips, no Direction Y.
    expect(chips().length).toBe(2)
  })

  it('shows and picks a Direction Y chip in rectangular mode', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature({ mode: 'rectangular', count_y: 2, pitch_y: 20, direction_y: [0, 1, 0] }), onMutation)
    // Field order: [0] Body, [1] Direction X, [2] Direction Y.
    const dirY = chips()[2]
    expect(dirY.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick edge or face, required)')
    fireEvent.click(dirY)
    pick('edge:ex1:?7;@ex1:edge')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_pattern_field', featureId: 'pt1', field: 'direction_y_query', value: '?7;@ex1:edge',
    })
  })
})
