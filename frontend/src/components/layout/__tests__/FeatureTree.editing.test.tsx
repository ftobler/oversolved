// The tree row marks which feature is being edited and swaps its edit button
// for the OK/Cancel pair, so an edit can be ended where it started. The editor
// body itself still lives in the floating FeatureEditPanel; before floating
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
    expect(row.querySelector('.feature-ok-btn')).not.toBeNull()
    expect(row.querySelector('.feature-cancel-btn')).not.toBeNull()
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
