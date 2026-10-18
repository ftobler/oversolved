// The tree row only marks which feature is being edited; the editor body and
// the OK/Cancel pair live in the floating FeatureEditPanel. Before floating
// panels the row grew by a whole form when a feature opened, which is the
// problem this feature set out to fix, so these pin that the row stays a row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen } from '@testing-library/react'
import { useEditorState } from '@/hooks/useEditorState'
import {
  makeCallbacks, renderSidebar, resetStores, setupEditingStore as setupStore,
  builtInFeatures, extrudeFeature,
} from './sidebarTestHarness'

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  resetStores()
})

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('FeatureTree editing row', () => {
  it('marks the edited row and adds no editor fields to it', () => {
    setupStore([...builtInFeatures, extrudeFeature], 'ex1')
    const { container } = renderSidebar()

    const row = screen.getByText('ex1').closest('.feature-item')!
    expect(row.classList.contains('editing')).toBe(true)
    expect(row.querySelector('.plane-editor')).toBeNull()
    expect(row.querySelector('input, select, textarea')).toBeNull()
    expect(container.querySelector('.feature-ok-btn')).toBeNull()
    expect(container.querySelector('.feature-cancel-btn')).toBeNull()
    expect(container.querySelector('.status-message')).toBeNull()
  })

  it('scrolls the edited row into view when an edit starts', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    setupStore([...builtInFeatures, extrudeFeature], null)
    renderSidebar(makeCallbacks())
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() => { useEditorState.setState({ editingFeatureId: 'ex1' }) })

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})
