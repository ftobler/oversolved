import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { DELETE_BODY_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'

function makeFeature(bodies: string[] = []): PartFeature {
  return {
    id: 'db1',
    kind: 'delete_body',
    label: 'Delete Body',
    delete_body: { bodies },
  }
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

describe('DeleteBodyEditor (via FeatureEditor)', () => {
  it('renders empty chip when no body selected', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_BODY_SCHEMA} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders one chip item per picked body', () => {
    const feature = makeFeature(['@body_ex1', '@body_ex2'])
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_BODY_SCHEMA} />)
    const chips = [...document.querySelectorAll('.feature-pick-chip-item-text')]
    expect(chips.map(c => c.textContent)).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('clicking chip toggles picking state', () => {
    const feature = makeFeature()
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={DELETE_BODY_SCHEMA} />)
    const chip = document.querySelector('.feature-pick-chip')!
    expect(chip.classList.contains('picking')).toBe(false)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })

  it('remove button emits remove_delete_body_ref for that index', () => {
    const feature = makeFeature(['@body_ex1', '@body_ex2'])
    const onMutation = vi.fn()
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={DELETE_BODY_SCHEMA} />)
    const removeBtns = document.querySelectorAll('.feature-pick-chip-item-remove')
    fireEvent.click(removeBtns[1])
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_delete_body_ref', featureId: 'db1', index: 1 })
  })

  it('picking a body emits add_delete_body_ref and keeps the field open', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_BODY_SCHEMA} />)
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    pick('face:ex1:?4;@ex1:face')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: 'face:ex1:?4;@ex1:face',
    })
    // multi: the chip stays armed so the next body can be picked without re-arming.
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'db1', field: 'bodies', multi: true })
  })

  it('collects a second pick instead of replacing the first', () => {
    const onMutation = vi.fn()
    // The doc mutation is external to the editor, so re-render with the value the
    // first pick would have written and confirm the second pick still appends.
    const { rerender } = render(
      <FeatureEditor feature={makeFeature()} onMutation={onMutation} schema={DELETE_BODY_SCHEMA} />,
    )
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    pick('face:ex1:?4;@ex1:face')
    rerender(
      <FeatureEditor feature={makeFeature(['face:ex1:?4;@ex1:face'])} onMutation={onMutation} schema={DELETE_BODY_SCHEMA} />,
    )
    pick('face:ex2:?4;@ex2:face')
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'add_delete_body_ref', featureId: 'db1', bodyQuery: 'face:ex2:?4;@ex2:face',
    })
    expect(onMutation).toHaveBeenCalledTimes(2)
  })

  it('re-picking an already-picked body removes it again', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor feature={makeFeature(['@body_ex1'])} onMutation={onMutation} schema={DELETE_BODY_SCHEMA} />,
    )
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    // Arming syncs the chip's values into the selection; toggling one back off is
    // the viewport re-click.
    pick('@body_ex1')
    expect(onMutation).toHaveBeenCalledWith({ type: 'remove_delete_body_ref', featureId: 'db1', index: 0 })
  })
})
