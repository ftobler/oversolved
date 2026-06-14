import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { runPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'

beforeEach(() => {
  useSketchEditorStore.setState({
    isPointerDown: false,
    orbitEnabled: true,
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

  it('restores orbitEnabled when isPointerDown is true', () => {
    useSketchEditorStore.setState({
      isPointerDown: true,
      orbitEnabled: false,
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
    expect(state.orbitEnabled).toBe(true)
  })

  it('leaves orbitEnabled unchanged when isPointerDown is false', () => {
    useSketchEditorStore.setState({
      isPointerDown: false,
      orbitEnabled: false,
    })

    runPointerUpCleanup()

    const state = useSketchEditorStore.getState()
    expect(state.isPointerDown).toBe(false)
    expect(state.orbitEnabled).toBe(false)
  })
})
