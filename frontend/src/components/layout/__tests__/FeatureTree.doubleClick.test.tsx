import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import {
  makeCallbacks, renderSidebar, resetStores, setupEditingStore as setupStore,
  builtInFeatures, extrudeFeature, sketchFeature,
} from './sidebarTestHarness'

beforeEach(() => {
  resetStores()
})

describe('FeatureTree double-click to edit', () => {
  it('double-clicking an extrude row opens it via onEnterEditFeature', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!
    fireEvent.doubleClick(extrudeItem)

    expect(onEnterEditFeature).toHaveBeenCalledTimes(1)
    expect(onEnterEditFeature).toHaveBeenCalledWith('ex1')
    expect(onEnterEditSketch).not.toHaveBeenCalled()
  })

  it('double-clicking a sketch row opens it via onEnterEditSketch', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, sketchFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const sketchItem = screen.getByText('sk1').closest('.feature-item')!
    fireEvent.doubleClick(sketchItem)

    expect(onEnterEditSketch).toHaveBeenCalledTimes(1)
    expect(onEnterEditSketch).toHaveBeenCalledWith('sk1')
    expect(onEnterEditFeature).not.toHaveBeenCalled()
  })

  it('double-clicking a built-in (Origin) row calls neither handler', () => {
    const onEnterEditFeature = vi.fn()
    const onEnterEditSketch = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features)
    renderSidebar(makeCallbacks({ onEnterEditFeature, onEnterEditSketch }))

    const originItem = screen.getByText('Origin').closest('.feature-item')!
    fireEvent.doubleClick(originItem)

    expect(onEnterEditFeature).not.toHaveBeenCalled()
    expect(onEnterEditSketch).not.toHaveBeenCalled()
  })

  it('double-clicking the feature already being edited does not open again', () => {
    const onEnterEditFeature = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 'ex1')  // ex1 is already the editing feature
    renderSidebar(makeCallbacks({ onEnterEditFeature }))

    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!
    fireEvent.doubleClick(extrudeItem)

    expect(onEnterEditFeature).not.toHaveBeenCalled()
  })
})
