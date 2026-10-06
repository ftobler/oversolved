import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerFeatureHandleCallbacks, resetFeatureHandleCallbacksForTest } from '../featureHandleCallbacks'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, EDGE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sketchVertexAdapter } from '../sketchVertexAdapter'
import { sketchEntityAdapter } from '../sketchEntityAdapter'
import { markDrawToolClickConsumed, takeDrawToolClickConsumed } from '../drawToolClickGuard'
import type { ActiveTool } from '@/types/cad'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture } from './idBufferDispatchHarness'

describe('useIdBufferPointerDispatch', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }
  beforeEach(() => {
    ({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
  })
  afterEach(() => {
    disposeIdBufferDispatchFixture(pipeline)
  })

  describe('pointerdown on sketch vertex (Guard 1)', () => {
    const VERTEX_KEY = 'vertex:feat1:line1:start'

    function stubVertexHit() {
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 2, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0,
      })
    }

    function firePointerDown(canvas: HTMLCanvasElement) {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 200, clientY: 200, bubbles: true }))
    }

    it('calls sketchVertexAdapter.onPointerDown when activeTool is null (default mode)', async () => {
      stubVertexHit()
      useSketchEditorStore.setState({ activeTool: null })
      const spy = vi.spyOn(sketchVertexAdapter, 'onPointerDown')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      await act(async () => { firePointerDown(canvas) })
      expect(spy).toHaveBeenCalledWith(VERTEX_KEY, 200, 200)
      spy.mockRestore()
    })

    it('calls sketchVertexAdapter.onPointerDown when activeTool is drag', async () => {
      stubVertexHit()
      useSketchEditorStore.setState({ activeTool: 'drag' })
      const spy = vi.spyOn(sketchVertexAdapter, 'onPointerDown')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      await act(async () => { firePointerDown(canvas) })
      expect(spy).toHaveBeenCalledWith(VERTEX_KEY, 200, 200)
      spy.mockRestore()
    })

    it('calls sketchVertexAdapter.onPointerDown when no tool is active', async () => {
      stubVertexHit()
      useSketchEditorStore.setState({ activeTool: null })
      const spy = vi.spyOn(sketchVertexAdapter, 'onPointerDown')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      await act(async () => { firePointerDown(canvas) })
      expect(spy).toHaveBeenCalledWith(VERTEX_KEY, 200, 200)
      spy.mockRestore()
    })

    it('does NOT call sketchVertexAdapter.onPointerDown when a drawing tool is active', async () => {
      stubVertexHit()
      useSketchEditorStore.setState({ activeTool: 'line' })
      const spy = vi.spyOn(sketchVertexAdapter, 'onPointerDown')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      await act(async () => { firePointerDown(canvas) })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe('draw-tool click guard (project commit on pointer-down)', () => {
    const EDGE_KEY = '?17;@gedge_abc:edge'

    function stubEdgeHit() {
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 3, layer: EDGE_LAYER_NAME, entityKey: EDGE_KEY, distancePx: 0,
      })
    }

    beforeEach(() => {
      // The project tool resets the tool to null after committing on pointer-down,
      // so by click time the tool reads as null (all layers allowed).
      useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })
      takeDrawToolClickConsumed()  // clear any leaked flag from prior tests
    })

    it('skips normal selection when a drawing tool already consumed the click', async () => {
      stubEdgeHit()
      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      markDrawToolClickConsumed()  // mimic DrawPlane.onPointerDown for the project tool
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      // The source edge must NOT land in normal selection, and we never even resolve.
      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(pipeline.resolveSync).not.toHaveBeenCalled()
    })

    it('toggles normal selection on a B-rep hit when the click was not consumed', async () => {
      stubEdgeHit()
      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(useSketchEditorStore.getState().normalSelection.has(EDGE_KEY)).toBe(true)
    })
  })

  describe('draw-tool click consumption on sketch layers', () => {
    const VERTEX_KEY = 'vertex:feat1:line1:start'

    function stubVertexHit() {
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 2, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0,
      })
    }

    beforeEach(() => {
      // A drawing tool is active: DrawPlane commits on pointer-down and claims
      // the click, so the trailing canvas click must not toggle selection.
      useSketchEditorStore.setState({ activeTool: 'line', activeFeatureId: 'feat1', normalSelection: new Set() })
      takeDrawToolClickConsumed()  // clear any leaked flag from prior tests
    })

    it('skips normal selection on a sketch vertex when a drawing tool consumed the click', async () => {
      stubVertexHit()
      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      markDrawToolClickConsumed()  // mimic DrawPlane.onPointerDown for every drawing tool
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(pipeline.resolveSync).not.toHaveBeenCalled()
    })

    it('leaves selection alone for a plain draw over empty space', async () => {
      pipeline.resolveSync = vi.fn().mockReturnValue(null)
      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
      }))

      markDrawToolClickConsumed()
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
      expect(pipeline.resolveSync).not.toHaveBeenCalled()
    })

    // The DrawPlane pointer-down marks the click consumed for EVERY drawing tool
    // (Drawing.tsx), so a line/rect/circle/... gesture that snaps its release onto
    // an existing sketch vertex must not toggle that vertex into normal selection.
    // `line` is covered above; these pin the rest of the drawing family.
    const DRAWING_TOOLS = ['rect', 'center_rect', 'circle', 'arc', 'ellipse', 'spline', 'point', 'ngon'] as ActiveTool[]
    it.each(DRAWING_TOOLS)(
      'skips normal selection for the %s tool after its draw pointer-down consumed the click',
      async (tool) => {
        useSketchEditorStore.setState({ activeTool: tool, activeFeatureId: 'feat1', normalSelection: new Set() })
        stubVertexHit()
        renderHook(() => useIdBufferPointerDispatch({
          glRef: glRef as { current: import('three').WebGLRenderer | null },
          consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
        }))

        markDrawToolClickConsumed()  // mimic DrawPlane.onPointerDown for every drawing tool
        await act(async () => {
          canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
        })

        expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
        expect(pipeline.resolveSync).not.toHaveBeenCalled()
      },
    )
  })

  it('a pointer-down on a feature handle starts its drag', async () => {
    resetFeatureHandleCallbacksForTest()
    const onPointerDown = vi.fn()
    registerFeatureHandleCallbacks('fhandle:extrude1', { onPointerDown, onDoubleClick: () => {} })
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: FEATURE_HANDLE_LAYER_NAME, entityKey: 'fhandle:extrude1', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 30, clientY: 40 }))
    })

    expect(onPointerDown).toHaveBeenCalledWith(30, 40)
    resetFeatureHandleCallbacksForTest()
  })

  it('a pointer-down on a sketch entity starts a drag in select/drag mode but not while drawing', async () => {
    const KEY = 'entity:feat1:line1'
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: SKETCH_ENTITY_LAYER_NAME, entityKey: KEY, distancePx: 0,
    })
    const spy = vi.spyOn(sketchEntityAdapter, 'onPointerDown')

    useSketchEditorStore.setState({ activeTool: null })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_ENTITY_LAYER_NAME]),
    }))
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(spy).toHaveBeenCalledWith(KEY, 10, 10)

    spy.mockClear()
    useSketchEditorStore.setState({ activeTool: 'line' })
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
