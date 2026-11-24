import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { usePartEditorStore } from '@/stores/partEditorStore'
import {
  makeCallbacks, renderSidebar, resetStores, setupRollbackStore as setupStore,
  grabRollback, movePointer, releasePointer, layoutFeatureRows, pressRow,
  builtInFeatures, extrudeFeature, sketchFeature, featureRow,
} from './sidebarTestHarness'
import { useEditorState } from '@/hooks/useEditorState'

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

  it('moves the one bar to the preview slot and drops the edge cue', () => {
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar()
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(170)  // upper half of sk1 (row 4 spans 160..200): preview slot 4

    // The bar is a new DOM node at each slot, so re-query the live one.
    const movedBar = screen.getByTitle('Rollback')
    expect(document.querySelectorAll('.rollback-bar')).toHaveLength(1)
    expect(movedBar.classList.contains('dragging')).toBe(true)
    expect(movedBar.closest('li')?.nextElementSibling).toBe(featureRow('sk1'))
    for (const row of document.querySelectorAll('.feature-item')) {
      expect(row.classList.contains('drop-target-top')).toBe(false)
      expect(row.classList.contains('drop-target-bottom')).toBe(false)
    }
  })

  it('dims the rows from the preview slot on while the bar is dragged', () => {
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar()
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(170)  // preview slot 4

    expect(featureRow('Right').classList.contains('rolled-back')).toBe(false)
    expect(featureRow('sk1').classList.contains('rolled-back')).toBe(true)
    expect(featureRow('ex1').classList.contains('rolled-back')).toBe(true)
  })

  it('moves the bar back to the committed slot on Escape', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    grabRollback(screen.getByTitle('Rollback'))
    movePointer(170)  // preview slot 4
    expect(screen.getByTitle('Rollback').closest('li')?.nextElementSibling).toBe(featureRow('sk1'))

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onSetRollbackPosition).not.toHaveBeenCalled()
    expect(screen.getByTitle('Rollback').closest('li')?.previousElementSibling).toBe(featureRow('ex1'))
    expect(featureRow('sk1').classList.contains('rolled-back')).toBe(false)
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

    expect(onSetRollbackPosition).toHaveBeenCalledTimes(1)
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
    expect(screen.getByTitle('Rollback').classList.contains('dragging')).toBe(false)
  })

  it('does not highlight built-in features during rollback bar drag', () => {
    const onSetRollbackPosition = vi.fn()
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 1)
    renderSidebar(makeCallbacks({ onSetRollbackPosition }))
    layoutFeatureRows()

    const originItem = featureRow('Origin')

    grabRollback(screen.getAllByTitle('Rollback')[0])
    movePointer(10)  // over Origin, which the bar may never be parked above
    expect(originItem.classList.contains('drop-target-top')).toBe(false)
    expect(originItem.classList.contains('drop-target-bottom')).toBe(false)

    releasePointer(10)
    expect(onSetRollbackPosition).toHaveBeenCalledWith(4)  // clamped past the built-ins
  })

  it('still reorders features and draws the insertion line on a feature drag', () => {
    const onMutation = vi.fn()
    const features = [...builtInFeatures, sketchFeature, extrudeFeature]
    setupStore(features, 6)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    // sk1 sits at index 4, ex1 at 5: the lower half of ex1 is slot 6.
    pressRow(featureRow('sk1'), { clientY: 180 })
    movePointer(230)
    expect(featureRow('ex1').classList.contains('drop-target-bottom')).toBe(true)
    expect(document.querySelector('.features-list')?.classList.contains('features-list--dragging')).toBe(true)
    releasePointer(230)

    expect(onMutation).toHaveBeenCalledWith({
      type: 'reorder_features',
      featureId: 'sk1',
      toIndex: 6,
    })
    expect(document.querySelector('.features-list')?.classList.contains('features-list--dragging')).toBe(false)
  })

  it('keeps the bar at its committed slot while a feature row is dragged', () => {
    setupStore([...builtInFeatures, sketchFeature, extrudeFeature], 5)
    renderSidebar()
    layoutFeatureRows()

    pressRow(featureRow('sk1'), { clientY: 180 })
    movePointer(230)

    // Slot 6 is the feature's drop target, not the bar's; the bar stays at 5.
    expect(screen.getByTitle('Rollback').closest('li')?.previousElementSibling).toBe(featureRow('sk1'))
    expect(featureRow('ex1').classList.contains('rolled-back')).toBe(true)
  })

  it('adds the no-hover class to the list only while the bar is grabbed', () => {
    const features = [...builtInFeatures, extrudeFeature]
    setupStore(features, 4)
    renderSidebar()

    const list = document.querySelector('.features-list')!
    expect(list.classList.contains('features-list--dragging')).toBe(false)

    grabRollback(screen.getByTitle('Rollback'))
    expect(list.classList.contains('features-list--dragging')).toBe(true)

    releasePointer(500)
    expect(list.classList.contains('features-list--dragging')).toBe(false)
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
    useEditorState.setState({
    editingFeatureId: 'ex1',
  })
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
    useEditorState.setState({
    editingFeatureId: 'sk1',
  })
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

