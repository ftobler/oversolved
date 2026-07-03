import { describe, it, expect, vi, beforeEach } from 'vitest'
import { featureHandleAdapter } from '../featureHandleAdapter'
import {
  registerFeatureHandleCallbacks,
  resetFeatureHandleCallbacksForTest,
} from '../featureHandleCallbacks'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'

beforeEach(() => resetFeatureHandleCallbacksForTest())

describe('featureHandleAdapter', () => {
  it('routes onPointerDown to the registered callback for the key', () => {
    const onPointerDown = vi.fn()
    registerFeatureHandleCallbacks('fhandle:ex1:distance', { onPointerDown, onDoubleClick: () => {} })
    expect(featureHandleAdapter.onPointerDown('fhandle:ex1:distance', 10, 20)).toBe(true)
    expect(onPointerDown).toHaveBeenCalledWith(10, 20)
  })

  it('routes onDoubleClick to the registered callback for the key', () => {
    const onDoubleClick = vi.fn()
    registerFeatureHandleCallbacks('fhandle:ex1:distance', { onPointerDown: () => {}, onDoubleClick })
    expect(featureHandleAdapter.onDoubleClick('fhandle:ex1:distance', 3, 4)).toBe(true)
    expect(onDoubleClick).toHaveBeenCalledWith(3, 4)
  })

  it('returns false when no callback is registered', () => {
    expect(featureHandleAdapter.onPointerDown('fhandle:unknown:distance', 0, 0)).toBe(false)
    expect(featureHandleAdapter.onDoubleClick('fhandle:unknown:distance', 0, 0)).toBe(false)
  })

  it('unregister stops further routing', () => {
    const onPointerDown = vi.fn()
    const unregister = registerFeatureHandleCallbacks('fhandle:ex1:distance', { onPointerDown, onDoubleClick: () => {} })
    unregister()
    expect(featureHandleAdapter.onPointerDown('fhandle:ex1:distance', 0, 0)).toBe(false)
    expect(onPointerDown).not.toHaveBeenCalled()
  })
})

describe('feature_handle drag state', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({ drag: null, dragPending: null, dragStartClient: null, isPointerDown: false })
  })

  it('flows through setDragPending/setDrag and blocks orbit while pointer is down', () => {
    const st = useSketchEditorStore.getState()
    st.setIsPointerDown(true)
    st.setDragPending({
      type: 'feature_handle', featureId: 'ex1', field: 'distance',
      startValue: 10, axisOrigin: [5, 5, 5], axisDir: [0, 0, 1], unitScale: 1, min: 0.01,
    })
    let s = useSketchEditorStore.getState()
    expect(deriveOrbitEnabled(s.isPointerDown, s.drag, s.dragPending)).toBe(false)

    st.setDrag({
      type: 'feature_handle', featureId: 'ex1', field: 'distance',
      startValue: 10, currentValue: 12.5, axisOrigin: [5, 5, 5], axisDir: [0, 0, 1], unitScale: 1, min: 0.01,
    })
    s = useSketchEditorStore.getState()
    expect(s.drag?.type).toBe('feature_handle')
    expect(deriveOrbitEnabled(s.isPointerDown, s.drag, s.dragPending)).toBe(false)

    // Release: orbit must come back the moment the pointer is up.
    st.setIsPointerDown(false)
    st.setDrag(null)
    st.setDragPending(null)
    s = useSketchEditorStore.getState()
    expect(deriveOrbitEnabled(s.isPointerDown, s.drag, s.dragPending)).toBe(true)
  })
})
