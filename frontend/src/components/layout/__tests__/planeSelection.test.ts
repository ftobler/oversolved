import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { registerCommand, executeCommand, clearAllHandlers } from '@/utils/core/commandRegistry'
import { buildCommandEntries } from '@/pages/commandEntries'

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

// There is no dedicated cancel_pick command: Escape routes to cancel_draw, which
// is the superset (draw + pick field + tool). This drives the real entry so a
// dropped setActivePickField step there strands an armed pick chip.
describe('cancel_draw command', () => {
  const noop = () => {}

  beforeEach(() => {
    reset()
    for (const e of buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)) {
      registerCommand(e.name, e.fn)
    }
  })

  it('dispatching cancel_draw clears the active pick field', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    executeCommand('cancel_draw')
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })
})
