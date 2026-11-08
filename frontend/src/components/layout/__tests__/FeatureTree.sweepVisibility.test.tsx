// The sweep row had no visibility eye because the tree gated the button on a
// hand-written sketch/plane expression. It is a body-making feature, so its eye
// hides the bodies the sweep created; this test pins the row half.
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import {
  builtInFeatures, makeCallbacks, renderSidebar, resetStores, setupEditingStore as setupStore,
} from './sidebarTestHarness'

const sweepFeature: PartFeature = {
  id: 'sw1',
  kind: 'sweep',
  sweep: { sketch: '$sk1', path: '$hx1' },
}

beforeEach(() => {
  resetStores()
})

describe('FeatureTree sweep visibility', () => {
  it('renders the eye on a sweep row and dispatches the visibility toggle', () => {
    setupStore([...builtInFeatures, sweepFeature], null)
    const callbacks = makeCallbacks()
    renderSidebar(callbacks)

    const row = screen.getByText('sw1').closest('.feature-item')!
    const eye = row.querySelector('.feature-visibility-btn')
    expect(eye).not.toBeNull()
    expect(row.querySelector('.feature-visibility-placeholder')).toBeNull()

    fireEvent.click(eye!)
    expect(callbacks.onToggleVisibility).toHaveBeenCalledWith('sw1')
  })

  it('dims the row once the sweep is hidden', () => {
    setupStore([...builtInFeatures, sweepFeature], null)
    const visible = usePartEditorStore.getState().visibleFeatures
    usePartEditorStore.setState({ visibleFeatures: new Set([...visible].filter(id => id !== 'sw1')) })
    renderSidebar()

    const row = screen.getByText('sw1').closest('.feature-item')!
    expect(row.classList.contains('invisible')).toBe(true)
  })
})
