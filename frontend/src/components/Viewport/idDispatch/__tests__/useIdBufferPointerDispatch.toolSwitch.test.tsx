import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch } from '../useIdBufferPointerDispatch'
import { IdPipeline, EDGE_LAYER_NAME, FACE_LAYER_NAME, PLANE_LAYER_NAME } from '@/picking'
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
      // No active tool allows every layer: the first move resolves, the second queues.
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

  it('recomputes the allowed set when a queued trailing hover flushes after a tool switch', async () => {
    // The trailing resolve replays at the FRAME boundary, but the tool may have
    // switched since the move was queued. Replaying the queue-time allowed set
    // would apply (and leave stuck) a hover for a layer the new tool forbids.
    const resolved: number[] = []
    pipeline.resolveAsync = vi.fn().mockImplementation(async (_gl, cursor: { x: number; y: number }) => {
      resolved.push(cursor.x)
      return { id: 1, layer: FACE_LAYER_NAME, entityKey: '@feat1/face/0', distancePx: 0 }
    }) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME]),
    }))

    await act(async () => {
      // Idle select allows faces: first move resolves, second queues behind it.
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 50 }))
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 50 }))
      await Promise.resolve()
    })
    expect(resolved).toEqual([10])

    await act(async () => {
      // Tool switch within the frame: 'line' forbids the face layer entirely.
      useSketchEditorStore.setState({ activeTool: 'line' })
    })

    await flushHoverFrame()

    // No trailing resolve fired and nothing leaked into the hover state.
    expect(resolved).toEqual([10])
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  // L5a: the effective allowed set is cached keyed on activeTool; a tool switch
  // must invalidate that cache so the next event re-derives the filter.
  it('re-derives the allowed layer set on the next event after a tool change', async () => {
    useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })
    pipeline.resolveSync = vi.fn().mockImplementation(
      (_gl: unknown, _cursor: unknown, opts?: { allowedLayers?: ReadonlySet<string> }) => {
        if (opts?.allowedLayers && !opts.allowedLayers.has(EDGE_LAYER_NAME)) return null
        return { id: 1, layer: EDGE_LAYER_NAME, entityKey: 'e', pickKey: 'b#edge#0', distancePx: 0 }
      },
    ) as unknown as typeof pipeline.resolveSync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(wasLastClickConsumedByIdDispatch()).toBe(true)

    act(() => { useSketchEditorStore.setState({ activeTool: 'line' }) })  // line forbids EDGE

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })
    expect(wasLastClickConsumedByIdDispatch()).toBe(false)
  })

  // L6: a hover applied under one tool's filter must not survive a keyboard tool
  // switch that forbids the layer until the next pointer move.
  it('drops a B-rep hover the instant a keyboard tool switch forbids the layer', async () => {
    useSketchEditorStore.setState({ activeTool: null })
    pipeline.target.markClean()
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => ({
      id: 1, layer: EDGE_LAYER_NAME, entityKey: 'edgeQ', pickKey: 'b#edge#0', distancePx: 0,
    })) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 40 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('edgeQ')

    act(() => { useSketchEditorStore.setState({ activeTool: 'line' }) })  // line forbids EDGE

    // No further pointer event.
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('keeps a still-allowed hover across a tool switch that does not forbid the layer', async () => {
    useSketchEditorStore.setState({ activeTool: null })
    pipeline.target.markClean()
    pipeline.resolveAsync = vi.fn().mockImplementation(async () => ({
      id: 1, layer: PLANE_LAYER_NAME, entityKey: '@builtin_front', pickKey: '@builtin_front', distancePx: 0,
    })) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 40 }))
      await Promise.resolve()
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@builtin_front')

    act(() => { useSketchEditorStore.setState({ activeTool: 'drag' }) })  // drag applies no filter

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@builtin_front')
  })

  // L6 in-flight gap: a tool switch between resolveHover launching the readback
  // and its promise resolving, with nothing hovered yet, must still invalidate
  // that readback so it cannot paint a highlight the new tool forbids.
  it('invalidates an in-flight hover readback on a tool switch even with nothing hovered', async () => {
    useSketchEditorStore.setState({ activeTool: null })
    let landReadback: (hit: unknown) => void = () => {}
    pipeline.resolveAsync = vi.fn().mockImplementation(
      () => new Promise(resolve => { landReadback = resolve }),
    ) as unknown as typeof pipeline.resolveAsync

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
    })

    // Tool switch before the readback resolves; no hover was ever applied.
    act(() => { useSketchEditorStore.setState({ activeTool: 'line' }) })

    await act(async () => {
      landReadback({ id: 1, layer: EDGE_LAYER_NAME, entityKey: 'edgeQ', pickKey: 'b#edge#0', distancePx: 0 })
      await Promise.resolve()
    })

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })
})
