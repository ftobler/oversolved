import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch,
} from '../useIdBufferPointerDispatch'
import { registerFeatureHandleCallbacks, resetFeatureHandleCallbacksForTest } from '../featureHandleCallbacks'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import {
  IdPipeline, DIMENSION_LABEL_LAYER_NAME, EDGE_LAYER_NAME, FACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, type ResolvedHit,
} from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { toolRegistry } from '@/registry/toolRegistry'
import { initializeTools } from '@/tools'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture } from './idBufferDispatchHarness'
import { takeDrawToolClickConsumed } from '../drawToolClickGuard'
import { takeBandClickConsumed } from '../bandClickGuard'

const HANDLE_KEY = 'fhandle:extrude1:distance'
const FACE_KEY = '?2;@body_1@extrude1/face/3'
const EDGE_KEY = '?2;@body_1@extrude1/edge/5'
const VERTEX_KEY = 'vertex:feat1:line1:start'

const handleHit: ResolvedHit = { id: 1, layer: FEATURE_HANDLE_LAYER_NAME, entityKey: HANDLE_KEY, distancePx: 0 }
const faceHit: ResolvedHit = { id: 2, layer: FACE_LAYER_NAME, entityKey: FACE_KEY, distancePx: 0 }
const edgeHit: ResolvedHit = { id: 5, layer: EDGE_LAYER_NAME, entityKey: EDGE_KEY, distancePx: 0 }
const vertexHit: ResolvedHit = { id: 3, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0 }
const dimLabelHit: ResolvedHit = { id: 4, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0 }

// The pending/drag shapes FeatureHandles.tsx seeds for a draggable arrow.
const HANDLE_PENDING = {
  type: 'feature_handle' as const,
  featureId: 'extrude1',
  field: 'distance',
  startValue: 10,
  axisOrigin: [0, 0, 0] as [number, number, number],
  axisDir: [0, 0, 1] as [number, number, number],
  unitScale: 1,
  min: 0.01,
}

function pointerDown(canvas: HTMLCanvasElement, button = 0) {
  canvas.dispatchEvent(new MouseEvent('pointerdown', { button, clientX: 30, clientY: 40 }))
}

function pointerMove(canvas: HTMLCanvasElement, buttons: number) {
  canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 80, buttons }))
}

function click(canvas: HTMLCanvasElement) {
  canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 60, clientY: 80 }))
}

function armFeatureHandle() {
  const st = useSketchEditorStore.getState()
  st.setIsPointerDown(true)
  st.setDragStartClient([30, 40])
  st.setDragPending(HANDLE_PENDING)
}

describe('useIdBufferPointerDispatch handle gesture', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }

  beforeEach(() => {
    resetFeatureHandleCallbacksForTest()
    takeDrawToolClickConsumed()  // clear flags a prior test in this file may have left
    takeBandClickConsumed()
    useEditorState.setState({
      activeTool: null,
      activeFeatureId: null,
      normalSelection: new Set(),
      selectedPicks: new Map(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      drag: null,
      dragPending: null,
      dragStartClient: null,
      isPointerDown: false,
    })
    ;({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
    pipeline.target.markClean()
  })

  afterEach(() => {
    disposeIdBufferDispatchFixture(pipeline)
  })

  async function seedEdgeHover(): Promise<ReturnType<typeof vi.fn>> {
    const spy = vi.fn().mockResolvedValue(edgeHit)
    pipeline.resolveAsync = spy
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    return spy
  }

  describe('T4: a handle drag release over a face', () => {
    it('consumes the release click instead of toggling the face under the cursor', async () => {
      registerFeatureHandleCallbacks(HANDLE_KEY, {
        onPointerDown: () => armFeatureHandle(),
        onDoubleClick: () => {},
      })
      pipeline.resolveSync = vi.fn()
        .mockReturnValueOnce(handleHit)
        .mockReturnValueOnce(faceHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
      })
      // The arrow armed the drag exactly like FeatureHandles.tsx does, and the
      // drag then went live on the move.
      expect(useSketchEditorStore.getState().dragPending?.type).toBe('feature_handle')
      act(() => {
        useSketchEditorStore.getState().setDrag({ ...HANDLE_PENDING, currentValue: 12 })
      })
      await act(async () => {
        pointerMove(canvas, 1)
        click(canvas)
      })

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })

  describe('T5: the handle refuses the drag (an expression value)', () => {
    it('still consumes the release click', async () => {
      // A non-draggable handle's callback returns without arming anything; the
      // ownership comes from the press layer, not from a live drag. The null
      // assertion is the contrast with T4, whose callback does arm one.
      registerFeatureHandleCallbacks(HANDLE_KEY, { onPointerDown: () => {}, onDoubleClick: () => {} })
      pipeline.resolveSync = vi.fn()
        .mockReturnValueOnce(handleHit)
        .mockReturnValueOnce(faceHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
        pointerMove(canvas, 1)
        click(canvas)
      })

      expect(useSketchEditorStore.getState().dragPending).toBeNull()
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })

  describe('T6: hover during the handle drag', () => {
    it('clears a non-handle hover applied before the press and keeps the arrow hot', async () => {
      // The stale highlight this guards: the cursor moved onto the arrow, the
      // previous element's hover landed a frame later, and the press then froze
      // hover. Without reconciliation that highlight stays lit for the drag.
      registerFeatureHandleCallbacks(HANDLE_KEY, { onPointerDown: () => {}, onDoubleClick: () => {} })
      pipeline.resolveSync = vi.fn().mockReturnValue(handleHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, EDGE_LAYER_NAME]),
      }))

      const hoverSpy = await seedEdgeHover()
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe(EDGE_KEY)
      hoverSpy.mockClear()

      await act(async () => {
        pointerDown(canvas)
        pointerMove(canvas, 1)
        await Promise.resolve()
      })

      expect(hoverSpy).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe(HANDLE_KEY)
    })

    it('re-applies the arrow after a mid-drag pointerleave cleared the hover', async () => {
      registerFeatureHandleCallbacks(HANDLE_KEY, { onPointerDown: () => {}, onDoubleClick: () => {} })
      pipeline.resolveSync = vi.fn().mockReturnValue(handleHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
        pointerMove(canvas, 1)
      })
      act(() => {
        canvas.dispatchEvent(new Event('pointerleave'))
      })
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()

      await act(async () => {
        pointerMove(canvas, 1)
      })
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBe(HANDLE_KEY)
    })
  })

  describe('T7: an ordinary click keeps working', () => {
    it('toggles a face click that no handle press preceded', async () => {
      pipeline.resolveSync = vi.fn().mockReturnValue(faceHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FACE_LAYER_NAME]),
      }))

      await act(async () => {
        click(canvas)
      })

      expect(useSketchEditorStore.getState().normalSelection.has(FACE_KEY)).toBe(true)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })

  describe('T8 (audit): a sketch vertex drag release', () => {
    it('does not toggle the dragged vertex into the selection, and keeps hover live', async () => {
      toolRegistry.reset()
      initializeTools()
      useEditorState.setState({ activeFeatureId: 'feat1' })
      pipeline.resolveSync = vi.fn().mockReturnValue(vertexHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
      })
      // The adapter armed the drag; the drag then activated on a later move.
      expect(useSketchEditorStore.getState().dragPending).not.toBeNull()
      act(() => {
        useSketchEditorStore.getState().setDrag({
          type: 'vertex',
          vertexId: VERTEX_KEY,
          featureId: 'feat1',
          entityId: 'line1',
          vertexKey: 'start',
          startWorld: [0, 0],
          currentWorld: [1, 1],
          startClient: [30, 40],
        })
      })
      // DragTool snaps from the hover fields, so a sketch drag must not freeze
      // the hover the way a handle drag does.
      const hoverSpy = vi.fn().mockResolvedValue(vertexHit)
      pipeline.resolveAsync = hoverSpy
      await act(async () => {
        pointerMove(canvas, 1)
        await Promise.resolve()
      })
      expect(hoverSpy).toHaveBeenCalled()
      act(() => {
        useSketchEditorStore.getState().setDrag(null)
      })

      await act(async () => {
        click(canvas)
      })

      expect(useSketchEditorStore.getState().normalSelection.has(VERTEX_KEY)).toBe(false)
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })

  describe('gesture edge cases', () => {
    it('a second finger does not drop the handle gesture ownership', async () => {
      registerFeatureHandleCallbacks(HANDLE_KEY, { onPointerDown: () => {}, onDoubleClick: () => {} })
      pipeline.resolveSync = vi.fn()
        .mockReturnValueOnce(handleHit)
        .mockReturnValue(faceHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
      })
      const secondFinger = new MouseEvent('pointerdown', { button: 0, clientX: 70, clientY: 90 })
      Object.defineProperty(secondFinger, 'isPrimary', { value: false })
      await act(async () => {
        canvas.dispatchEvent(secondFinger)
      })
      await act(async () => {
        click(canvas)
      })

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })

    it('arms when this press replaces a dragPending stranded by an earlier gesture', async () => {
      // A release outside the window can leave a pending drag behind. This
      // press replaces it, which must still arm the click owner.
      useSketchEditorStore.getState().setDragPending({
        type: 'vertex',
        vertexId: VERTEX_KEY,
        featureId: 'feat1',
        entityId: 'line1',
        vertexKey: 'start',
        startWorld: [0, 0],
      })
      registerDimCallbacks('c1', {
        onOver: () => {},
        onOut: () => {},
        onClick: () => {},
        onDoubleClick: () => {},
        onPointerDown: () => {
          const st = useSketchEditorStore.getState()
          st.setDragStartClient([30, 40])
          st.setDragPending({
            type: 'dim_label',
            constraintId: 'c1',
            featureId: 'feat1',
            anchorWorld: [0, 0],
            startWorld: [0, 0],
          })
        },
      })
      pipeline.resolveSync = vi.fn()
        .mockReturnValueOnce(dimLabelHit)
        .mockReturnValue(faceHit)
      // The drag move's hover read goes through resolveAsync, which internally
      // calls resolveSync; keep it off the sync mock so the click still names
      // the face.
      pipeline.resolveAsync = vi.fn().mockResolvedValue(null)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
      })
      expect(useSketchEditorStore.getState().dragPending?.type).toBe('dim_label')
      act(() => {
        useSketchEditorStore.getState().setDrag({
          type: 'dim_label',
          constraintId: 'c1',
          featureId: 'feat1',
          anchorWorld: [0, 0],
          startWorld: [0, 0],
          currentWorld: [1, 1],
        })
      })
      await act(async () => {
        pointerMove(canvas, 1)
      })
      act(() => {
        useSketchEditorStore.getState().setDrag(null)
      })

      await act(async () => {
        click(canvas)
      })

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })
})
