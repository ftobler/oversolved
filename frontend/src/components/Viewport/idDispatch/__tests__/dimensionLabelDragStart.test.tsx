import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks, resetDimCallbacksForTest } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

class StubRenderer {
  domElement: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) { this.domElement = canvas }
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 800; c.height = 600
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
  })
  return c
}

describe('useIdBufferPointerDispatch: dimension label drag start', () => {
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

  it('routes pointerdown on a dimension label to the registered onPointerDown callback', async () => {
    const onPointerDown = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {},
      onClick: () => {},
      onPointerDown,
    })

    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(onPointerDown).toHaveBeenCalledTimes(1)
    expect(onPointerDown).toHaveBeenCalledWith(100, 100)
  })

  it('does not fire pointerdown on a non-left button', async () => {
    const onPointerDown = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {},
      onClick: () => {},
      onPointerDown,
    })

    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 100, clientY: 100 }))
    })

    expect(onPointerDown).not.toHaveBeenCalled()
  })
})
