import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks, resetDimCallbacksForTest } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, EDGE_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sketchVertexAdapter } from '../sketchVertexAdapter'
import { markDrawToolClickConsumed, takeDrawToolClickConsumed } from '../drawToolClickGuard'

class StubRenderer {
  domElement: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) { this.domElement = canvas }
}

/**
 * Let the hover throttle's trailing frame fire. Hover resolves are capped at ~two
 * per animation frame (see onPointerMove): the first move in a frame reads the ID
 * buffer straight away, later ones wait for the frame boundary.
 */
async function flushHoverFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await Promise.resolve()
  })
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 800; c.height = 600
  // jsdom doesn't lay out elements; stub getBoundingClientRect so cursor
  // math sees a 800x600 viewport at origin.
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
  })
  return c
}

describe('useIdBufferPointerDispatch', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }
  beforeEach(() => {
    resetDimCallbacksForTest()
    canvas = makeCanvas()
    pipeline = new IdPipeline({ width: 800, height: 600 })
    setLivePipeline(pipeline)
    glRef = { current: new StubRenderer(canvas) }
    useSketchEditorStore.setState({ activeTool: 'select' })
  })
  afterEach(() => {
    setLivePipeline(null)
    pipeline.dispose()
  })

  it('fires registered onClick when the resolver returns a dimension label hit', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })

    // Stub resolveSync to return a dimensionLabel hit regardless of cursor.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(100, 100)
  })

  it('does not fire when the active tool excludes the dimensionLabel layer', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })

    // Switch to a drawing tool that excludes dimensionLabel.
    useSketchEditorStore.setState({ activeTool: 'line' })

    const resolveSpy = vi.fn().mockReturnValue({
      id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
    })
    pipeline.resolveSync = resolveSpy

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(resolveSpy).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
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
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
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
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))

      await act(async () => { firePointerDown(canvas) })
      expect(spy).toHaveBeenCalledWith(VERTEX_KEY, 200, 200)
      spy.mockRestore()
    })

    it('calls sketchVertexAdapter.onPointerDown when activeTool is select', async () => {
      stubVertexHit()
      useSketchEditorStore.setState({ activeTool: 'select' })
      const spy = vi.spyOn(sketchVertexAdapter, 'onPointerDown')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
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
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
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

  it('hover stream calls onOver then onOut as the resolved key changes', async () => {
    const onOver = vi.fn()
    const onOut = vi.fn()
    registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })

    let nextHit: { layer: string; entityKey: string } | null = {
      layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1',
    }
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => nextHit ? { ...nextHit, id: 1, distancePx: 0 } : null)

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    expect(onOver).toHaveBeenCalledTimes(1)

    // Move away: resolver returns null -> onOut fires. This second move lands in
    // the frame the first one claimed, so it resolves at the frame boundary.
    nextHit = null
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(onOut).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of moves within one frame into one trailing resolve', async () => {
    // The cost this guards: every resolve is a blocking readRenderTargetPixels, so
    // a 120 Hz pointer must not buy 120 GPU stalls per second on a heavy model.
    const resolved: number[] = []
    pipeline.resolveAsync = vi.fn().mockImplementation(async (_gl, cursor: { x: number; y: number }) => {
      resolved.push(cursor.x)
      return null
    }) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      for (const x of [10, 20, 30, 40, 50]) {
        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 50 }))
      }
      await Promise.resolve()
    })

    // Leading edge only: the other four moves are still waiting on the frame.
    expect(resolved).toEqual([10])

    await flushHoverFrame()

    // One trailing resolve, at the LATEST cursor -- the intermediate ones are dropped.
    expect(resolved).toEqual([10, 50])
  })

  it('drops the queued hover when the tool stops accepting the consumed layers', async () => {
    // A move that arrives with nothing allowed clears the hover. Anything queued
    // behind it was captured under the OLD allowed set, so it must die with the
    // clear -- otherwise it resolves a frame later and re-applies a hover the
    // active tool no longer accepts, with no further event to take it back down.
    const resolved: number[] = []
    pipeline.resolveAsync = vi.fn().mockImplementation(async (_gl, cursor: { x: number; y: number }) => {
      resolved.push(cursor.x)
      return null
    }) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      // 'select' allows every layer: the first move resolves, the second queues.
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 50 }))
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 50 }))
      await Promise.resolve()
    })
    expect(resolved).toEqual([10])

    await act(async () => {
      // A sketch draw tool allows no B-rep layer, so the edge layer this
      // dispatcher consumes intersects to nothing.
      useSketchEditorStore.setState({ activeTool: 'line' })
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 50 }))
      await Promise.resolve()
    })

    await flushHoverFrame()

    expect(resolved).toEqual([10])
  })

  it('hover over sketchSurface layer sets hoveredSelectionId', async () => {
    pipeline.resolveAsync = vi.fn().mockResolvedValue({
      id: 1, layer: SKETCH_SURFACE_LAYER_NAME, entityKey: 'sk1/surf:face0', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_SURFACE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('sk1/surf:face0')
  })
})
