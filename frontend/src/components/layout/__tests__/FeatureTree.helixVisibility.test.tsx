// The helix is reference geometry, so its tree row offers the same eye as a
// sketch or plane. Without it the only way to hide the curve was to hide its
// consumer, which is not what the curve is.
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { PartFeature } from '@/types/cad'
import {
  builtInFeatures, makeCallbacks, renderSidebar, resetStores, setupEditingStore as setupStore, featureRow,
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

    const row = featureRow('hx1')
    const eye = row.querySelector('.feature-visibility-btn')
    expect(eye).not.toBeNull()
    // The helix owns a visibility button, so it needs no reserved empty slot.
    expect(row.querySelector('.feature-visibility-placeholder')).toBeNull()

    fireEvent.click(eye!)
    expect(callbacks.onToggleVisibility).toHaveBeenCalledWith('hx1')
  })

  it('offers the same eye on a solid feature, which hides the bodies it made', () => {
    setupStore([...builtInFeatures, extrudeFeature], null)
    renderSidebar()

    const row = featureRow('ex1')
    expect(row.querySelector('.feature-visibility-btn')).not.toBeNull()
    expect(row.querySelector('.feature-visibility-placeholder')).toBeNull()
  })
})
