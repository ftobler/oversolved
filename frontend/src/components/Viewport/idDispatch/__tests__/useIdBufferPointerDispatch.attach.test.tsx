import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { IdPipeline, EDGE_LAYER_NAME } from '@/picking'
import { StubRenderer } from './pickCanvasFixture'
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

  it('attaches once the canvas appears, not only at mount', async () => {
    // The Viewport can mount the hook before the renderer hands it a canvas, so
    // the effect retries on an animation frame instead of going deaf.
    glRef.current = null
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: EDGE_LAYER_NAME, entityKey: 'e', pickKey: 'k', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    glRef.current = new StubRenderer(canvas)
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(pipeline.resolveSync).toHaveBeenCalled()
  })

  it('keeps polling frame by frame until the canvas appears', async () => {
    // One retry is not enough: the renderer can take several frames to attach
    // its canvas, and a one-shot retry would leave the dispatcher deaf.
    glRef.current = null
    pipeline.resolveSync = vi.fn().mockReturnValue(null)

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    // First frame: still no canvas, so another frame must be booked.
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    glRef.current = new StubRenderer(canvas)
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(pipeline.resolveSync).toHaveBeenCalled()
  })

  it('attaches through the canvas ref and refuses to resolve without a renderer', async () => {
    // The ref is the first choice for the listen target; a canvas without a
    // renderer still must not throw or resolve through a missing GL context.
    const spy = vi.fn().mockReturnValue(null)
    pipeline.resolveSync = spy as unknown as typeof pipeline.resolveSync
    glRef.current = null

    renderHook(() => useIdBufferPointerDispatch({
      canvasRef: { current: canvas },
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves the cursor unscaled when the canvas has no backing size', async () => {
    // A canvas that has not sized its drawing buffer (width/height 0) would
    // divide the cursor to 0 without the guard, sending every pick to the
    // top-left corner.
    canvas.width = 0
    canvas.height = 0
    const spy = vi.fn().mockReturnValue(null)
    pipeline.resolveSync = spy as unknown as typeof pipeline.resolveSync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 50 }))
    })

    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][1]).toEqual({ x: 100, y: 50 })
  })
})
