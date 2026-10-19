// The action buttons sit inside the feature row, and that row's own onClick
// selects the feature (FeatureTree.tsx). Any action button that lets the click
// bubble therefore performs its action AND changes the selection, which is
// never what the user asked for. While a feature is edited the row swaps its
// edit button for the OK/Cancel pair, so ending the edit does not require a
// trip to the floating FeatureEditPanel on the other side of the viewport.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { FeatureItemActions } from '@/components/layout/FeatureItemActions'

type Handlers = ReturnType<typeof makeHandlers>

function makeHandlers() {
  return {
    onEnterEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
  }
}

/** Renders the actions inside a row whose click selects the feature, so a
 *  bubbling button click is observable as a rowClick call. */
function renderRow(
  over: { featureKind: string; isEditing?: boolean },
  handlers: Handlers,
) {
  const rowClick = vi.fn()
  render(
    <div onClick={rowClick}>
      <FeatureItemActions
        featureKind={over.featureKind}
        featureId="f1"
        isEditing={over.isEditing ?? false}
        isBuiltIn={false}
        isOrigin={false}
        isVisible={true}
        hasVisibility={true}
        {...handlers}
      />
    </div>
  )
  return rowClick
}

describe('FeatureItemActions click isolation', () => {
  it('does not select the feature when the sketch edit button is clicked', () => {
    const handlers = makeHandlers()
    const rowClick = renderRow({ featureKind: 'sketch' }, handlers)
    fireEvent.click(document.querySelector('.feature-edit-btn')!)
    expect(handlers.onEnterEditSketch).toHaveBeenCalledWith('f1')
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('does not select the feature when a non-sketch edit button is clicked', () => {
    const handlers = makeHandlers()
    const rowClick = renderRow({ featureKind: 'extrude' }, handlers)
    fireEvent.click(document.querySelector('.feature-edit-btn')!)
    expect(handlers.onEnterEditFeature).toHaveBeenCalledWith('f1')
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('keeps every other action button from reaching the row', () => {
    const handlers = makeHandlers()
    const rowClick = renderRow({ featureKind: 'sketch' }, handlers)
    fireEvent.click(document.querySelector('.feature-visibility-btn')!)
    fireEvent.click(document.querySelector('.feature-context-btn')!)
    expect(handlers.onToggleVisibility).toHaveBeenCalledWith('f1')
    expect(handlers.onRightClick).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('shows the OK/Cancel pair in the row while the feature is edited', () => {
    const handlers = makeHandlers()
    const rowClick = renderRow({ featureKind: 'sketch', isEditing: true }, handlers)
    fireEvent.click(document.querySelector('.feature-ok-btn')!)
    fireEvent.click(document.querySelector('.feature-cancel-btn')!)
    expect(handlers.onEditCommit).toHaveBeenCalledTimes(1)
    expect(handlers.onEditCancel).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
    // The context menu stays; the edit and visibility buttons make way.
    expect(document.querySelector('.feature-context-btn')).not.toBeNull()
    expect(document.querySelector('.feature-edit-btn')).toBeNull()
    expect(document.querySelector('.feature-visibility-btn')).toBeNull()
  })
})
