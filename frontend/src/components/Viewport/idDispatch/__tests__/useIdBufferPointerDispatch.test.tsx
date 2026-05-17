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
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick })

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
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick })

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

  it('hover stream calls onOver then onOut as the resolved key changes', async () => {
    const onOver = vi.fn()
    const onOut = vi.fn()
    registerDimCallbacks('c1', { onOver, onOut, onClick: () => {} })

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

    // Move away: resolver returns null -> onOut fires.
    nextHit = null
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 50 }))
      await Promise.resolve()
    })
    expect(onOut).toHaveBeenCalledTimes(1)
  })
})
