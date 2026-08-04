import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { registerCommand, executeCommand, unregisterCommand, clearAllHandlers } from '@/utils/core/commandRegistry'

// Plane selection is no longer a parallel store path. It is just a pick field
// (`activePickField = { featureId, field: 'plane' }`) consumed by PlaneSelector
// via usePickField. These tests cover the store-level coordinator and the
// cancel command. The plane-query stripping + mutation dispatch lives in the
// PlaneSelector component (see PlaneSelector.test.tsx).

beforeEach(() => { clearAllHandlers() })

function reset() {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    hoveredSelectionId: null,
    isPointerDown: false,
    activePickField: null,
    // The pick field owns the top of the mode stack, so a test that leaves a
    // field armed must have its entry cleared too or the next pick stacks a
    // second 'pick' on the leftover.
    modeStack: [],
  })
}

describe('activePickField initial state', () => {
  it('is null by default', () => {
    reset()
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })
})

describe('setActivePickField for a plane field', () => {
  beforeEach(reset)

  it('sets the field', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'sketch1', field: 'plane' })
  })

  it('clears with null', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    useSketchEditorStore.getState().setActivePickField(null)
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })
})

describe('cancel_pick command', () => {
  beforeEach(() => {
    reset()
    registerCommand('cancel_pick', () => {
      useSketchEditorStore.getState().setActivePickField(null)
    })
  })

  it('dispatching cancel_pick clears the active pick field', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    executeCommand('cancel_pick')
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })

  it('unregister cleanup', () => {
    unregisterCommand('cancel_pick')
  })
})
