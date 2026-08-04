import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useIdBufferPointerDispatch,
  wasLastClickConsumedByIdDispatch,
} from '../useIdBufferPointerDispatch'
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

describe('dimensionLabel pick goes through the id buffer (267.3 cutover)', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }
  beforeEach(() => {
    resetDimCallbacksForTest()
    canvas = makeCanvas()
    pipeline = new IdPipeline({ width: 800, height: 600 })
    setLivePipeline(pipeline)
    glRef = { current: new StubRenderer(canvas) }
    useSketchEditorStore.setState({ activeTool: null })  // idle select is activeTool null
  })
  afterEach(() => {
    setLivePipeline(null)
    pipeline.dispose()
  })

  it('a click resolved through resolveSync invokes the registered onClick exactly once', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {},
      onClick, onDoubleClick: () => {}, onPointerDown: () => {},
    })

    const resolveSpy = vi.fn().mockReturnValue({
      id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
    })
    pipeline.resolveSync = resolveSpy

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })

    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('wasLastClickConsumedByIdDispatch flips true after a label hit, false after a miss', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {},
      onClick, onDoubleClick: () => {}, onPointerDown: () => {},
    })

    let nextHit: { layer: string; entityKey: string } | null = {
      layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1',
    }
    pipeline.resolveSync = vi.fn().mockImplementation(() => nextHit ? { ...nextHit, id: 1, distancePx: 0 } : null)

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(wasLastClickConsumedByIdDispatch()).toBe(true)

    nextHit = null
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 700, clientY: 10 }))
    })
    expect(wasLastClickConsumedByIdDispatch()).toBe(false)
  })
})
