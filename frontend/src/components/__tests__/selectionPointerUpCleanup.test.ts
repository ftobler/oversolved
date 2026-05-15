import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { runPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'

beforeEach(() => {
  useSketchEditorStore.setState({
    isPointerDown: false,
    dynamicSelection: new Set(),
    normalSelection: new Set(),
  })
})

describe('runPointerUpCleanup', () => {
  it('does nothing when isPointerDown is false', () => {
    useSketchEditorStore.setState({
      isPointerDown: false,
      dynamicSelection: new Set(['entity:S1:L1']),
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.normalSelection.size).toBe(0)
    expect(state.dynamicSelection.size).toBe(1)
    expect(state.isPointerDown).toBe(false)
  })

  it('clears isPointerDown even when dynamicSelection is empty', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
      dynamicSelection: new Set(),
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
    expect(state.normalSelection.size).toBe(0)
  })

  it('applies dynamic selection to normal selection', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
      dynamicSelection: new Set(['entity:S1:L1', 'vertex:S1:L1:start']),
      normalSelection: new Set(),
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.normalSelection.has('entity:S1:L1')).toBe(true)
    expect(state.normalSelection.has('vertex:S1:L1:start')).toBe(true)
    expect(state.dynamicSelection.size).toBe(0)
    expect(state.isPointerDown).toBe(false)
  })

  it('toggles off an item already in normal selection', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
      dynamicSelection: new Set(['entity:S1:L1']),
      normalSelection: new Set(['entity:S1:L1']),
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.normalSelection.has('entity:S1:L1')).toBe(false)
    expect(state.dynamicSelection.size).toBe(0)
  })

  it('called twice in a row: second call is a no-op (isPointerDown already false)', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
      dynamicSelection: new Set(['entity:S1:L1']),
      normalSelection: new Set(),
    })

    runPointerUpCleanup()
    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.normalSelection.has('entity:S1:L1')).toBe(true)
    expect(state.normalSelection.size).toBe(1)
  })
})
