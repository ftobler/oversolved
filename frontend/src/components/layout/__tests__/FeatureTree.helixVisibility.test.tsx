// The helix is reference geometry, so its tree row offers the same eye as a
// sketch or plane. Without it the only way to hide the curve was to hide its
// consumer, which is not what the curve is.
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { PartFeature } from '@/types/cad'
import {
  builtInFeatures, makeCallbacks, renderSidebar, resetStores, setupEditingStore as setupStore,
} from './sidebarTestHarness'

const helixFeature: PartFeature = { id: 'hx1', kind: 'helix', helix: {} }
const extrudeFeature: PartFeature = { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 10 } }

beforeEach(() => {
  resetStores()
})

describe('FeatureTree helix visibility', () => {
  it('renders the eye button on a helix row and dispatches the visibility toggle', () => {
    setupStore([...builtInFeatures, helixFeature], null)
    const callbacks = makeCallbacks()
    renderSidebar(callbacks)

    const row = screen.getByText('hx1').closest('.feature-item')!
    const eye = row.querySelector('.feature-visibility-btn')
    expect(eye).not.toBeNull()
    // The helix owns a visibility button, so it needs no reserved empty slot.
    expect(row.querySelector('.feature-visibility-placeholder')).toBeNull()

    fireEvent.click(eye!)
    expect(callbacks.onToggleVisibility).toHaveBeenCalledWith('hx1')
  })

  it('still reserves the slot on a solid feature, which cannot be hidden as a feature', () => {
    setupStore([...builtInFeatures, extrudeFeature], null)
    renderSidebar()

    const row = screen.getByText('ex1').closest('.feature-item')!
    expect(row.querySelector('.feature-visibility-btn')).toBeNull()
    expect(row.querySelector('.feature-visibility-placeholder')).not.toBeNull()
  })
})
