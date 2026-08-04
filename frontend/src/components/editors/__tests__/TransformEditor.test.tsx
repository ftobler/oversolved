// The transform's body pick is a LIST: one transform moves every picked body
// equally. This covers the editor half of that -- the chip collects picks
// instead of replacing them, and it writes each ref verbatim, the same contract
// DeleteBodyEditor.test.tsx pins for the other plural body field.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { TRANSFORM_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'

function makeFeature(bodies: string[] = []): PartFeature {
  return {
    id: 'tr1',
    kind: 'transform',
    label: 'Transform',
    transform: { bodies, operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
  }
}

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

/** The bodies chip is the first pick chip in the transform editor. */
function bodiesChip(): Element {
  return document.querySelector('.feature-pick-chip')!
}

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(), chipOwnedSelection: new Set(), activePickField: null, modeStack: [],
  })
})

describe('TransformEditor (via FeatureEditor)', () => {
  it('renders one chip item per picked body', () => {
    render(<FeatureEditor feature={makeFeature(['@body_ex1', '@body_ex2'])} onMutation={vi.fn()} schema={TRANSFORM_SCHEMA} />)
    const chips = [...document.querySelectorAll('.feature-pick-chip-item-text')]
    expect(chips.map(c => c.textContent)).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('picking a body emits add_transform_body and keeps the field armed', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />)
    fireEvent.click(bodiesChip())
    pick('@body_ex1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_transform_body', featureId: 'tr1', bodyQuery: '@body_ex1',
    })
    // multi: the chip stays armed so the next body can be picked without re-arming.
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'tr1', field: 'bodies', multi: true })
  })

  it('collects a second pick instead of replacing the first', () => {
    const onMutation = vi.fn()
    // The doc mutation is external to the editor, so re-render with the value the
    // first pick would have written and confirm the second pick still appends.
    const { rerender } = render(
      <FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />,
    )
    fireEvent.click(bodiesChip())
    pick('@body_ex1')
    rerender(<FeatureEditor feature={makeFeature(['@body_ex1'])} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />)
    pick('@body_ex2')
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'add_transform_body', featureId: 'tr1', bodyQuery: '@body_ex2',
    })
    expect(onMutation).toHaveBeenCalledTimes(2)
  })

  it('remove button emits remove_transform_body for that index', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature(['@body_ex1', '@body_ex2'])} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />)
    fireEvent.click(document.querySelectorAll('.feature-pick-chip-item-remove')[1])
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_transform_body', featureId: 'tr1', index: 1 })
  })

  it('re-picking an already-picked body removes it again', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature(['@body_ex1'])} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />)
    fireEvent.click(bodiesChip())
    // Arming syncs the chip's values into the selection; toggling one back off is
    // the viewport re-click.
    pick('@body_ex1')
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_transform_body', featureId: 'tr1', index: 0 })
  })

  it('stores a picked ref verbatim, never narrowed to one body', () => {
    // Same reason DELETE_BODY_SCHEMA's field carries no transform: `@ex1` here
    // means EVERY body that feature made, and `resolveBodyPickRef` would coerce
    // it to `@body_ex1`, moving the first split sibling and leaving the rest.
    const onMutation = vi.fn()
    for (const picked of ['@ex1', '@body_ex1/face/0', '?4;@body_ex1_1@ex1:face']) {
      onMutation.mockClear()
      const { unmount } = render(
        <FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={TRANSFORM_SCHEMA} />,
      )
      fireEvent.click(bodiesChip())
      pick(picked)
      expect(onMutation, picked).toHaveBeenCalledWith({
        type: 'add_transform_body', featureId: 'tr1', bodyQuery: picked,
      })
      unmount()
      act(() => { useSketchEditorStore.setState({ normalSelection: new Set(), chipOwnedSelection: new Set(), activePickField: null, modeStack: [] }) })
    }
  })
})
