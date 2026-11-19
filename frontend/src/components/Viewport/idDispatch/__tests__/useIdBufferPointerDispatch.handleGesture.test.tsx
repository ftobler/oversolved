import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch,
} from '../useIdBufferPointerDispatch'
import { registerFeatureHandleCallbacks, resetFeatureHandleCallbacksForTest } from '../featureHandleCallbacks'
import {
  IdPipeline, FACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, type ResolvedHit,
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
const VERTEX_KEY = 'vertex:feat1:line1:start'

const handleHit: ResolvedHit = { id: 1, layer: FEATURE_HANDLE_LAYER_NAME, entityKey: HANDLE_KEY, distancePx: 0 }
const faceHit: ResolvedHit = { id: 2, layer: FACE_LAYER_NAME, entityKey: FACE_KEY, distancePx: 0 }
const vertexHit: ResolvedHit = { id: 3, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0 }

function pointerDown(canvas: HTMLCanvasElement, button = 0) {
  canvas.dispatchEvent(new MouseEvent('pointerdown', { button, clientX: 30, clientY: 40 }))
}

function pointerMove(canvas: HTMLCanvasElement, buttons: number) {
  canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 80, buttons }))
}

function click(canvas: HTMLCanvasElement) {
  canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 60, clientY: 80 }))
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

  describe('T4: a handle drag release over a face', () => {
    it('consumes the release click instead of toggling the face under the cursor', async () => {
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

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })
  })

  describe('T5: the handle refuses the drag (an expression value)', () => {
    it('still consumes the release click', async () => {
      // A non-draggable handle's callback returns without arming anything; the
      // ownership comes from the press layer, not from a live drag.
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
    it('does not resolve a hover for the face under the travelling cursor', async () => {
      registerFeatureHandleCallbacks(HANDLE_KEY, { onPointerDown: () => {}, onDoubleClick: () => {} })
      pipeline.resolveSync = vi.fn().mockReturnValue(handleHit)
      pipeline.resolveAsync = vi.fn().mockResolvedValue(faceHit)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME, FACE_LAYER_NAME]),
      }))

      await act(async () => {
        pointerDown(canvas)
        pointerMove(canvas, 1)
        await Promise.resolve()
      })

      expect(pipeline.resolveAsync).not.toHaveBeenCalled()
      expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
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
    it('does not toggle the dragged vertex into the selection', async () => {
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
      await act(async () => {
        pointerMove(canvas, 1)
      })
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
})
