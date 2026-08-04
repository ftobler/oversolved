/**
 * The linear/rectangular array's source body and direction are pickable. The
 * solver has always honoured `array.source_body` (resolveSourceBody) and
 * `array.direction_x_query` / `direction_y_query` (resolveDirectionQuery), but
 * the editor exposed no chips, so a multi-body document could only be arrayed on
 * whichever body came first, along the raw fallback vector. Mirrors the
 * circular-array body-pick coverage in CircularArrayEditor.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { ARRAY_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude' },
  { id: 'arr1', kind: 'array' },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'arr1',
    kind: 'array',
    label: 'Array',
    array: { mode: 'linear', count_x: 2, pitch_x: 20, direction_x: [1, 0, 0], operation: 'add', include_source: true, source_body: '', ...over },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation: () => void) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={ARRAY_SCHEMA} />)
}

/** All pick chips in schema field order. Linear mode: [0] Body, [1] Direction X. */
function chips(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('.feature-pick-chip')
}
const bodyChip = () => chips()[0]
const dirXChip = () => chips()[1]

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

beforeEach(() => {
  useSketchEditorStore.setState({
    // modeStack rides with activePickField: clearing the field alone would leave
    // the previous test's 'pick' entry for the next one to stack onto.
    normalSelection: new Set(), chipOwnedSelection: new Set(), activePickField: null, modeStack: [],
  })
})

describe('ArrayEditor source body pick (via FeatureEditor)', () => {
  it('renders an empty body chip hinting at the implicit first-body fallback', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = bodyChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(first body)')
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
      type: 'set_array_field', featureId: 'arr1', field: 'source_body', value: '@body_ex1',
    })
  })

  it('picking a face of a body keeps the inner query for the solver to resolve', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('face:ex1:?4;@ex1:face')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_array_field', featureId: 'arr1', field: 'source_body', value: '?4;@ex1:face',
    })
  })

  it('rejects picking the array\'s own body', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('@body_arr1')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('remove button clears source_body back to the fallback', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature({ source_body: '@body_ex1' }), onMutation)
    fireEvent.click(bodyChip().querySelector('.feature-pick-chip-item-remove')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_array_field', featureId: 'arr1', field: 'source_body', value: '',
    })
  })
})

describe('ArrayEditor direction pick (via FeatureEditor)', () => {
  it('renders an empty direction-X chip flagged as a required pick', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = dirXChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick edge or face, required)')
  })

  it('picking an edge stores its inner query as direction_x_query', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(dirXChip())
    pick('edge:ex1:?4;@ex1:edge')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_array_field', featureId: 'arr1', field: 'direction_x_query', value: '?4;@ex1:edge',
    })
  })

  it('toggling Invert X dispatches an invert_x field mutation', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    const rows = [...document.querySelectorAll<HTMLElement>('.feature-field-row')]
    const invertRow = rows.find((r) => r.querySelector('.feature-field-label')?.textContent === 'Invert X')!
    fireEvent.click(invertRow.querySelector('input[type="checkbox"]')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_array_field', featureId: 'arr1', field: 'invert_x', value: true,
    })
  })

  it('hides the Invert Y toggle in linear mode', () => {
    renderEditor(makeFeature(), vi.fn())
    const labels = [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
    expect(labels).toContain('Invert X')
    expect(labels).not.toContain('Invert Y')
  })

  it('hides the Direction Y chip in linear mode', () => {
    renderEditor(makeFeature(), vi.fn())
    // Linear mode: only Body + Direction X chips, no Direction Y.
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
      type: 'set_array_field', featureId: 'arr1', field: 'direction_y_query', value: '?7;@ex1:edge',
    })
  })
})
