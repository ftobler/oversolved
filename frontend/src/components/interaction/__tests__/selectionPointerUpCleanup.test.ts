import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { runPointerUpCleanup, runPointerUpDragSafetyNet, useSelectionPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'
import type { DragPendingState, DragState } from '@/stores/sketchEditorStore'

const pending: DragPendingState = {
  type: 'vertex',
  vertexId: 'vertex:f1:e1:start',
  featureId: 'f1',
  entityId: 'e1',
  vertexKey: 'start',
  startWorld: [0, 0],
}

const drag: DragState = {
  type: 'vertex',
  vertexId: 'vertex:f1:e1:start',
  featureId: 'f1',
  entityId: 'e1',
  vertexKey: 'start',
  startWorld: [0, 0],
  currentWorld: [1, 1],
  startClient: [10, 10],
}

beforeEach(() => {
  useSketchEditorStore.setState({
    isPointerDown: false,
    drag: null,
    dragPending: null,
    dragStartClient: null,
    dragSnap: null,
    normalSelection: new Set(),
  })
})

describe('runPointerUpCleanup', () => {
  it('does nothing when isPointerDown is false', () => {
    useSketchEditorStore.setState({
      isPointerDown: false,
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
  })

  it('clears isPointerDown when true', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
  })

  it('called twice in a row: second call is a no-op (isPointerDown already false)', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
    })

    runPointerUpCleanup()
    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
  })

  it('schedules a deferred safety net that recovers stuck drag state', () => {
    vi.useFakeTimers()
    try {
      // Simulate a lost gesture: dragPending was set on pointerdown but the
      // DragPlane that would clear it was unmounted by a load race.
      useSketchEditorStore.setState({ isPointerDown: true, dragPending: pending, dragStartClient: [10, 10] })

      runPointerUpCleanup()

      // isPointerDown cleared synchronously; drag state recovery is deferred.
      expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
      expect(useSketchEditorStore.getState().dragPending).toBe(pending)

      vi.runAllTimers()

      const state = useSketchEditorStore.getState()
      expect(state.dragPending).toBeNull()
      expect(state.dragStartClient).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deferred net does not clobber a drag committed by another pointerup handler', () => {
    vi.useFakeTimers()
    try {
      useSketchEditorStore.setState({ isPointerDown: true, drag, dragPending: pending, dragStartClient: [10, 10] })

      // runPointerUpCleanup runs first (registered at Viewport mount) and only
      // clears isPointerDown synchronously, leaving the drag intact for the
      // DragPlane commit handler that fires later in the same pointerup.
      runPointerUpCleanup()
      expect(useSketchEditorStore.getState().drag).toBe(drag)
      expect(useSketchEditorStore.getState().dragPending).toBe(pending)

      // The real commit handler clears the gesture synchronously...
      useSketchEditorStore.setState({ drag: null, dragPending: null, dragStartClient: null, dragSnap: null })

      // ...so by the time the deferred net runs there is nothing left to do.
      vi.runAllTimers()
      const state = useSketchEditorStore.getState()
      expect(state.drag).toBeNull()
      expect(state.dragPending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runPointerUpDragSafetyNet', () => {
  it('clears stuck drag and dragPending', () => {
    useSketchEditorStore.setState({ isPointerDown: false, drag, dragPending: pending, dragStartClient: [10, 10], dragSnap: null })

    runPointerUpDragSafetyNet()

    const state = useSketchEditorStore.getState()
    expect(state.drag).toBeNull()
    expect(state.dragPending).toBeNull()
    expect(state.dragStartClient).toBeNull()
  })

  it('leaves an in-flight gesture alone when isPointerDown is true', () => {
    useSketchEditorStore.setState({ isPointerDown: true, dragPending: pending, dragStartClient: [10, 10] })

    runPointerUpDragSafetyNet()

    const state = useSketchEditorStore.getState()
    expect(state.dragPending).toBe(pending)
    expect(state.dragStartClient).toEqual([10, 10])
  })

  it('is a no-op when there is no drag state', () => {
    useSketchEditorStore.setState({ isPointerDown: false, drag: null, dragPending: null })

    runPointerUpDragSafetyNet()

    const state = useSketchEditorStore.getState()
    expect(state.drag).toBeNull()
    expect(state.dragPending).toBeNull()
  })
})

describe('useSelectionPointerUpCleanup', () => {
  it('recovers a stuck drag when the window loses focus', () => {
    // Releasing the button outside the browser window delivers no pointerup or
    // pointercancel. The blur fallback must route through the same cleanup or
    // isPointerDown and the drag stay pinned.
    useSketchEditorStore.setState({
      isPointerDown: true, drag, dragPending: pending, dragStartClient: [10, 10], dragSnap: null,
    })
    renderHook(() => useSelectionPointerUpCleanup())

    act(() => { window.dispatchEvent(new Event('blur')) })

    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
  })
})
