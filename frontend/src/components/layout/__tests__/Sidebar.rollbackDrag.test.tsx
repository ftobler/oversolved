import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { usePartEditorStore } from '@/stores/partEditorStore'
import {
  makeCallbacks, renderSidebar, resetStores, setupRollbackStore as setupStore,
  createDragEvent, grabRollback, movePointer, releasePointer, layoutFeatureRows,
  builtInFeatures, extrudeFeature, sketchFeature,
} from './sidebarTestHarness'

beforeEach(() => {
  resetStores()
})

describe('rollback bar drag convergence', () => {
  it('adds dragging class to rollback bar while dragged', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(true)
  })

  it('shows drop-target-top when rollback bar dragged to top half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    grabRollback(rollbackBar)
    movePointer(170)  // upper half of ex1 (row 4 spans 160..200)

    expect(featureItem.classList.contains('drop-target-top')).toBe(true)
    expect(featureItem.classList.contains('drop-target-bottom')).toBe(false)
  })

  it('shows drop-target-bottom when rollback bar dragged to bottom half of a feature', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    const featureItem = screen.getByText('ex1').closest('.feature-item')!

    grabRollback(rollbackBar)
    movePointer(190)  // lower half of ex1

    expect(featureItem.classList.contains('drop-target-bottom')).toBe(true)
    expect(featureItem.classList.contains('drop-target-top')).toBe(false)
  })

  it('calls onSetRollbackPosition with correct index on rollback bar release', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(190)
    releasePointer(190)

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })

  it('releases the rollback bar while a rebuild is in progress', () => {
    // Native drag-and-drop lost the release when applying a finished rebuild
    // blocked the main thread past the last dragover, so the bar could not be
    // let go mid-rebuild. Pointer events must commit regardless.
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ isRebuilding: true })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(170)
    releasePointer(170)

    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)
    expect(screen.getByTitle('Rollback').classList.contains('dragging')).toBe(false)
  })

  it('abandons the drag on Escape without moving the bar', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    movePointer(170)
    fireEvent.keyDown(window, { key: 'Escape' })
    releasePointer(170)

    expect(onSetRollbackPosition).not.toHaveBeenCalled()
    expect(rollbackBar.classList.contains('dragging')).toBe(false)
  })

  it('does not highlight built-in features during rollback bar drag', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 1)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const originItem = screen.getByText('Origin').closest('.feature-item')!

    grabRollback(screen.getAllByTitle('Rollback')[0])
    movePointer(10)  // over Origin, which the bar may never be parked above
    expect(originItem.classList.contains('drop-target-top')).toBe(false)
    expect(originItem.classList.contains('drop-target-bottom')).toBe(false)

    releasePointer(10)
    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)  // clamped past the built-ins
  })

  it('still reorders features when dragging a feature item', () => {
    const onMutation = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar(makeCallbacks({ onMutation }))

    const sketchItem = screen.getByText('sk1').closest('.feature-item')!
    const extrudeItem = screen.getByText('ex1').closest('.feature-item')!

    vi.spyOn(extrudeItem, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 0,
      width: 200,
      height: 40,
      bottom: 140,
      right: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    })

    fireEvent(sketchItem, createDragEvent('dragstart', { dataTransferText: 'sk1' }))
    fireEvent(extrudeItem, createDragEvent('dragover', { clientY: 110 }))
    fireEvent(extrudeItem, createDragEvent('drop', { dataTransferText: 'sk1' }))

    expect(onMutation).toHaveBeenCalledWith({
      type: 'reorder_features',
      featureId: 'sk1',
      toIndex: 5,
    })
  })

  it('renders the rollback bar at the end when rollbackPosition is null', () => {
    // Edit exit resets rollbackPosition to null, meaning "end of stack".
    // The bar must still be drawn there, not vanish.
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, null)
    renderSidebar()

    expect(screen.getByTitle('Rollback')).toBeInTheDocument()
  })

  it('renders the rollback bar when rollbackPosition is stale past the end', () => {
    // Deleting features out of order can leave rollbackPosition > features.length
    // until the owner clamps it. Render must clamp to the end, not draw nothing.
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 99)
    renderSidebar()

    expect(screen.getByTitle('Rollback')).toBeInTheDocument()
  })

  it('rollback bar is not draggable while a feature is being edited', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ editingFeatureId: 'ex1' })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(false)

    releasePointer(170)
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it('mid-list rollback bar is not draggable while a feature is being edited', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 5)
    usePartEditorStore.setState({ editingFeatureId: 'sk1' })
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const rollbackBar = screen.getByTitle('Rollback')
    grabRollback(rollbackBar)
    expect(rollbackBar.classList.contains('dragging')).toBe(false)

    releasePointer(170)
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it('dragging the bar below every feature parks it at the end', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    releasePointer(500)  // below every feature row

    expect(onSetRollbackPosition).toHaveBeenCalledWith(5)
  })

  it('a click that does not move the bar commits nothing', () => {
    // The bar is 10px tall and sits inside a click-happy tree; a stray press
    // must not dirty the document with a rollback it never moved.
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    releasePointer(500)  // still past the last row, where the bar already is

    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

