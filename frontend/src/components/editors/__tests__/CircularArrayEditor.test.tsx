/**
 * The circular array's source body is pickable. The solver has always honoured
 * `source_body` (kernel/features/array.ts resolveSourceBody), but the editor
 * exposed no chip, so a document with more than one body could only be arrayed
 * on whichever body happened to come first in the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { CIRCULAR_ARRAY_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude' },
  { id: 'ca1', kind: 'circular_array' },
]

function makeFeature(source_body = ''): PartFeature {
  return {
    id: 'ca1',
    kind: 'circular_array',
    label: 'Circular Array',
    circular_array: { source_body, count: 4, operation: 'add', include_source: true },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation: () => void) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={CIRCULAR_ARRAY_SCHEMA} />)
}

/** The body chip is the first pick chip in the schema's field order. */
function bodyChip(): HTMLElement {
  return document.querySelectorAll<HTMLElement>('.feature-pick-chip')[0]
}

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(), chipOwnedSelection: new Set(), activePickField: null,
  })
})

describe('CircularArrayEditor body pick (via FeatureEditor)', () => {
  it('renders an empty chip hinting at the implicit first-body fallback', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = bodyChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(first body)')
  })

  it('renders the source_body ref when set', () => {
    renderEditor(makeFeature('@body_ex1'), vi.fn())
    // PickChip runs the ref through queryLabel when `features` is supplied.
    expect(bodyChip().querySelector('.feature-pick-chip-item-text')?.textContent).toBe('body_ex1')
  })

  it('picking a body normalizes to an @body_ ref', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('body:body_ex1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_array_field', featureId: 'ca1', field: 'source_body', value: '@body_ex1',
    })
  })

  it('picking a face of a body keeps the inner query for the solver to resolve', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('face:ex1:?4;@ex1:face')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_array_field', featureId: 'ca1', field: 'source_body', value: '?4;@ex1:face',
    })
  })

  it('rejects picking the array\'s own body', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(bodyChip())
    pick('@body_ca1')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('remove button clears source_body back to the fallback', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature('@body_ex1'), onMutation)
    fireEvent.click(bodyChip().querySelector('.feature-pick-chip-item-remove')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_array_field', featureId: 'ca1', field: 'source_body', value: '',
    })
  })
})
