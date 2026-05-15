import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { applyDynamicHover } from '@/components/Geometry3D/useHoverAndDynamicSelection'

beforeEach(() => {
  useSketchEditorStore.setState({
    isPointerDown: false,
    dynamicSelection: new Set(),
    normalSelection: new Set(),
    internalHoverSelection: null,
  })
})

describe('applyDynamicHover', () => {
  it('does not call updateDynamicSelection when isPointerDown is false', () => {
    const updateDynamicSelection = vi.fn()
    const ref = { current: null as string | null }

    applyDynamicHover('entity:S1:L1', false, ref, updateDynamicSelection)

    expect(updateDynamicSelection).not.toHaveBeenCalled()
    expect(ref.current).toBeNull()
  })

  it('calls updateDynamicSelection when isPointerDown is true', () => {
    const updateDynamicSelection = vi.fn()
    const ref = { current: null as string | null }

    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)

    expect(updateDynamicSelection).toHaveBeenCalledWith('entity:S1:L1')
    expect(ref.current).toBe('entity:S1:L1')
  })

  it('does not call updateDynamicSelection a second time for the same id without leaving', () => {
    const updateDynamicSelection = vi.fn()
    const ref = { current: null as string | null }

    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)
    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)

    expect(updateDynamicSelection).toHaveBeenCalledTimes(1)
  })

  it('calls updateDynamicSelection again after ref is reset (simulating onOut)', () => {
    const updateDynamicSelection = vi.fn()
    const ref = { current: null as string | null }

    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)
    ref.current = null
    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)

    expect(updateDynamicSelection).toHaveBeenCalledTimes(2)
  })

  it('updates ref.current to the new id when hovering a different element', () => {
    const updateDynamicSelection = vi.fn()
    const ref = { current: null as string | null }

    applyDynamicHover('entity:S1:L1', true, ref, updateDynamicSelection)
    applyDynamicHover('entity:S1:L2', true, ref, updateDynamicSelection)

    expect(updateDynamicSelection).toHaveBeenCalledWith('entity:S1:L1')
    expect(updateDynamicSelection).toHaveBeenCalledWith('entity:S1:L2')
    expect(updateDynamicSelection).toHaveBeenCalledTimes(2)
    expect(ref.current).toBe('entity:S1:L2')
  })
})

describe('updateDynamicSelection store action', () => {
  it('adds id to dynamicSelection when not present and not in normal selection', () => {
    useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
    expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(true)
  })

  it('removes id from dynamicSelection when id is also in normal selection', () => {
    useSketchEditorStore.setState({
      dynamicSelection: new Set(['entity:S1:L1']),
      normalSelection: new Set(['entity:S1:L1']),
    })
    useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
    expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(false)
  })

  it('updateDynamicSelection(null) clears all dynamic selection', () => {
    useSketchEditorStore.setState({
      dynamicSelection: new Set(['entity:S1:L1', 'vertex:S1:L1:start']),
    })
    useSketchEditorStore.getState().updateDynamicSelection(null)
    expect(useSketchEditorStore.getState().dynamicSelection.size).toBe(0)
  })
})
