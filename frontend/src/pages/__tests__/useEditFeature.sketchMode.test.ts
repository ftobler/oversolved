import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditFeature } from '@/pages/useEditFeature'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, PartFeature } from '@/types/cad'

// The panel mode follows the sketch edit: entering one switches to Sketch mode
// and leaving one switches back to Feature mode, so the user never has to find
// the (temporary) mode toggle by hand.
const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch' },
  { id: 'sk2', kind: 'sketch' },
  { id: 'ex1', kind: 'extrude' },
]

function setup() {
  const setMode = vi.fn(() => true)
  const { result } = renderHook(() => useEditFeature({
    features: FEATURES,
    builtInIds: new Set(),
    startEditSession: vi.fn(),
    commitEditSession: vi.fn(),
    cancelEditSession: vi.fn(),
    docRef: { current: { features: FEATURES } as PartDoc },
    reSolve: vi.fn(),
    setMode,
  }))
  return { result, setMode }
}

describe('useEditFeature sketch-mode automation', () => {
  beforeEach(() => {
    usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  })

  it('entering a sketch edit switches to sketch mode', () => {
    const { result, setMode } = setup()
    act(() => { result.current.enterEditSketch('sk1') })
    expect(setMode).toHaveBeenCalledWith('sketch')
  })

  it('exiting a sketch edit switches back to feature mode', () => {
    const { result, setMode } = setup()
    act(() => { result.current.enterEditSketch('sk1') })
    setMode.mockClear()
    act(() => { result.current.exitEditSketch() })
    expect(setMode).toHaveBeenCalledWith('feature')
  })

  it('cancelling a sketch edit switches back to feature mode', () => {
    const { result, setMode } = setup()
    act(() => { result.current.enterEditSketch('sk1') })
    setMode.mockClear()
    act(() => { result.current.cancelEditFeature() })
    expect(setMode).toHaveBeenCalledWith('feature')
  })

  it('leaving a non-sketch edit does not touch the mode', () => {
    const { result, setMode } = setup()
    act(() => { result.current.enterEditFeature('ex1') })
    setMode.mockClear()
    act(() => { result.current.commitEditFeature() })
    expect(setMode).not.toHaveBeenCalled()
  })

  it('switching from a sketch edit to another feature returns to feature mode', () => {
    const { result, setMode } = setup()
    act(() => { result.current.enterEditSketch('sk1') })
    setMode.mockClear()
    act(() => { result.current.enterEditFeature('ex1') })
    expect(setMode).toHaveBeenCalledWith('feature')
  })

  it('switching from one sketch to another stays in sketch mode', () => {
    // enterEditSketch already asked for sketch mode; bouncing back to feature
    // mode in between would flash the wrong toolbar.
    const { result, setMode } = setup()
    act(() => { result.current.enterEditSketch('sk1') })
    setMode.mockClear()
    act(() => { result.current.enterEditSketch('sk2') })
    expect(setMode).not.toHaveBeenCalledWith('feature')
    expect(setMode).toHaveBeenCalledWith('sketch')
  })
})
