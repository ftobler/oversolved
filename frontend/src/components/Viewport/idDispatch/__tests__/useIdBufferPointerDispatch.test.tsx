import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks, resetDimCallbacksForTest } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, EDGE_LAYER_NAME, ORIGIN_LAYER_NAME, PLANE_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sketchVertexAdapter } from '../sketchVertexAdapter'
import { markDrawToolClickConsumed, takeDrawToolClickConsumed } from '../drawToolClickGuard'
import type { ActiveTool } from '@/types/cad'

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
    useSketchEditorStore.setState({ activeTool: null })  // idle select is activeTool null
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

    it('calls sketchVertexAdapter.onPointerDown when no tool is active', async () => {
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

  it('toggles a sketch-surface hit query-only with no selectedPicks claim', async () => {
    // A sketch surface has no per-primitive identity (pickKey === query), so the
    // click must toggle the query wholesale like a sketch entity/vertex. Falling
    // into the B-rep else would mint a phantom {query -> {query}} claim.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: SKETCH_SURFACE_LAYER_NAME, entityKey: 'sk1/surf:face0', distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_SURFACE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('sk1/surf:face0')).toBe(true)
    expect(s.selectedPicks.size).toBe(0)
  })

  it.each([
    ['origin', ORIGIN_LAYER_NAME, '@builtin_origin'],
    ['plane', PLANE_LAYER_NAME, '@builtin_front'],
  ])('toggles a %s hit query-only with no selectedPicks claim (pickKey === query)', async (_label, layer, entityKey) => {
    // Origin/plane picks have no per-primitive identity, so the id-buffer
    // registration defaults pickKey to entityKey (IdRegistry.allocate). Passing
    // that pickKey through unchanged would mint a redundant self-claim
    // ({query -> {query}}) exactly like the sketch-surface case above.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 13, layer, entityKey, pickKey: entityKey, distancePx: 0,
    })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([layer]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has(entityKey)).toBe(true)
    expect(s.selectedPicks.size).toBe(0)
  })

  // The click -> claim-minting seam: the dispatcher is what carries the hit's
  // per-primitive pickKey into toggleNormalSelection. Without this pass-through
  // every b-rep pick would collapse onto the query alone (the pre-fix eviction
  // behaviour) no matter how precise the ID buffer was.
  describe('pickKey pass-through on B-rep clicks', () => {
    beforeEach(() => {
      useSketchEditorStore.setState({
        normalSelection: new Set(),
        selectedPicks: new Map(),
        activeTool: null,
      })
    })

    it('toggles the query and mints the hit pickKey claim', async () => {
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 10, layer: EDGE_LAYER_NAME, entityKey: '?03;abc:edge', pickKey: 'ex1/b0#edge#2', distancePx: 0,
      })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('?03;abc:edge')).toBe(true)
      expect(s.selectedPicks.get('?03;abc:edge')).toEqual(new Set(['ex1/b0#edge#2']))
    })

    it('a click on a colliding sibling is additive, never a replacement', async () => {
      // Two primitives that share a query (no construction UUID earned) resolve
      // to distinct pickKeys; the second click must add, not evict the first.
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 10, layer: EDGE_LAYER_NAME, entityKey: '?03;abc:edge', pickKey: 'ex1/b0#edge#2', distancePx: 0,
      })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 11, layer: EDGE_LAYER_NAME, entityKey: '?03;abc:edge', pickKey: 'ex1/b0#edge#3', distancePx: 0,
      })
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('?03;abc:edge')).toBe(true)
      expect(s.selectedPicks.get('?03;abc:edge')).toEqual(new Set(['ex1/b0#edge#2', 'ex1/b0#edge#3']))
    })
  })

  // Sketch entities have no per-primitive identity, so the dispatcher routes
  // them through sketchEntityAdapter.onClick, which toggles the query without a
  // pickKey. This pins that adapter fallback; it deliberately does not exercise
  // the claim-minting seam (the B-rep else branch above).
  describe('sketch-layer click toggles without a claim', () => {
    beforeEach(() => {
      useSketchEditorStore.setState({
        normalSelection: new Set(),
        selectedPicks: new Map(),
        activeTool: null,
      })
    })

    it('lands the query in normalSelection with no selectedPicks claim', async () => {
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 12, layer: SKETCH_ENTITY_LAYER_NAME, entityKey: 'entity:sk1:line1', distancePx: 0,
      })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([SKETCH_ENTITY_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('entity:sk1:line1')).toBe(true)
      expect(s.selectedPicks.size).toBe(0)
    })
  })

  // A stale-buffer miss (resolveSync null while the pipeline is dirty) is a
  // transient transition, not empty space: it must not finalise a dimension
  // placement, exactly as shouldClearSelectionOnBackplaneClick refuses to
  // clear selection on the same click.
  describe('dimension finalize vs stale buffer', () => {
    const PICK = { isVertex: false, target: 'entity:feat1:l1' }

    function setupDimensionGesture() {
      useSketchEditorStore.setState({
        activeTool: 'dimension',
        activeFeatureId: 'feat1',
        dimensionPicks: [PICK],
      })
      pipeline.resolveSync = vi.fn().mockReturnValue(null)
      return vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('does not finalise when the miss came from a stale (dirty) buffer', async () => {
      const spy = setupDimensionGesture()
      // A fresh pipeline starts dirty; make the state explicit anyway.
      pipeline.markDirty('test')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(spy).not.toHaveBeenCalled()
    })

    it('finalises on a clean empty-space click', async () => {
      const spy = setupDimensionGesture()
      pipeline.target.markClean()

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(spy).toHaveBeenCalledWith([100, 100])
    })
  })

  it('hover stream calls onOver then onOut as the resolved key changes', async () => {    const onOver = vi.fn()
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
})
