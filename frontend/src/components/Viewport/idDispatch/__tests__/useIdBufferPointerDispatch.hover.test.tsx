import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, EDGE_LAYER_NAME } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture, flushHoverFrame } from './idBufferDispatchHarness'

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

  it('hover stream calls onOver then onOut as the resolved key changes', async () => {
    const onOver = vi.fn()
    const onOut = vi.fn()
    registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })

    let nextHit: { layer: string; entityKey: string } | null = {
      layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1',
    }
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => nextHit ? { ...nextHit, id: 1, distancePx: 0 } : null)
    // A clean buffer: a null resolve here means empty space, so the hover clears.
    // A stale (dirty) buffer would retain the highlight instead (see the
    // dedicated stale-hover test below).
    pipeline.target.markClean()

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

  it('warns and keeps processing moves when applying a hover hit throws', async () => {
    // The former bare `.catch(() => {})` killed the apply silently: no trace,
    // and an adapter bug was indistinguishable from a dead hover stream.
    const onOver = vi.fn()
      .mockImplementationOnce(() => { throw new Error('adapter exploded') })
    const onOut = vi.fn()
    registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })

    const hit = { id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0 }
    pipeline.resolveAsync = vi.fn().mockResolvedValue(hit)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    expect(warn).toHaveBeenCalledWith('hover apply failed', expect.any(Error))

    // The state machine must still be alive: the next frame's resolve applies.
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()

    expect(onOver).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
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

  it('a resolveAsync readback landing after the returned clearHover does not resurrect the hover', async () => {
    // The pointer-leave race this closes: resolveHover launches the GPU
    // readback immediately (not deferred into an rAF the way AssemblyViewport's
    // hover path is), so a caller that only cancels the queued frame cannot
    // stop an already-launched readback from landing late and re-applying a
    // hover for a cursor position the pointer already left.
    let landReadback: (hit: unknown) => void = () => {}
    pipeline.resolveAsync = vi.fn().mockImplementation(
      () => new Promise(resolve => { landReadback = resolve }),
    ) as unknown as typeof pipeline.resolveAsync

    const { result } = renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_SURFACE_LAYER_NAME]),
    }))

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
    })

    // The pointer leaves before the readback lands -- this is exactly what
    // Viewport/index.tsx's handlePointerLeave calls.
    act(() => {
      result.current()
    })

    await act(async () => {
      landReadback({ id: 1, layer: SKETCH_SURFACE_LAYER_NAME, entityKey: 'sk1/surf:face0', distancePx: 0 })
      await Promise.resolve()
    })

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('clears the hover when the pointer leaves the canvas for an overlay', async () => {
    // A constraint tile / dimension label is a DOM sibling of the canvas inside
    // the R3F container, so a move onto one fires pointerleave on the canvas
    // and never reaches the move listener. Without the leave teardown the last
    // canvas hover would freeze under the overlay.
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

    act(() => {
      canvas.dispatchEvent(new Event('pointerleave'))
    })

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  // M1: the dedup cache is this dispatcher's private record of what is hovered.
  // Another writer that nulls the store hover (Body3D teardown on a solve
  // commit, Part.tsx resetTransientState) leaves the cache naming the old
  // primitive, so the next same-pixel move returns at applyHoverHit's guard and
  // the highlight never comes back. The store subscription drops the cache so
  // that move re-resolves.
  it('re-applies the hover after an external writer clears the store hover fields', async () => {
    pipeline.target.markClean()
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => ({
      id: 1, layer: EDGE_LAYER_NAME, entityKey: 'edgeQ', pickKey: 'b#edge#0', distancePx: 0,
    })) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('edgeQ')

    act(() => {
      const s = useSketchEditorStore.getState()
      s.setHoveredSelectionId(null)
      s.setHoveredPickKey(null)
    })
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('edgeQ')
  })

  it('re-applies a sketch-vertex hover after an external writer clears it', async () => {
    // The vertex adapter writes hoveredVertexId only, so the M1 branch above,
    // which watches hoveredSelectionId, never sees a vertex hover come and go.
    // After a feature switch clears the store, the cache must still be dropped
    // or the next same-pixel move returns at the dedup guard and the highlight
    // stays gone until the pointer leaves the vertex's reach.
    const VERTEX_KEY = 'vertex:feat1:line1:start'
    pipeline.target.markClean()
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => ({
      id: 2, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0,
    })) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredVertexId).toBe(VERTEX_KEY)

    act(() => {
      useSketchEditorStore.getState().clearSelectionAndHover()
    })
    expect(useSketchEditorStore.getState().hoveredVertexId).toBeNull()

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredVertexId).toBe(VERTEX_KEY)
  })
})
