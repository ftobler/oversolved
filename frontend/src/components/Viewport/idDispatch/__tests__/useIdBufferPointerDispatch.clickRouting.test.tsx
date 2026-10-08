import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import { registerFeatureHandleCallbacks, resetFeatureHandleCallbacksForTest } from '../featureHandleCallbacks'
import {
  IdPipeline, DIMENSION_LABEL_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  EDGE_LAYER_NAME, FACE_LAYER_NAME, ORIGIN_LAYER_NAME, PLANE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
} from '@/picking'
import { initializeTools } from '@/tools'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
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

  it('a non-primary click never resolves or toggles selection', async () => {
    // Middle/right clicks belong to orbit/context-menu; a primary-button pick
    // must not run for them (the browser also fires `click` for button 1).
    pipeline.resolveSync = vi.fn()
    useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 2, clientX: 5, clientY: 5 }))
    })

    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  describe('double-click routing', () => {
    afterEach(() => { resetFeatureHandleCallbacksForTest(); vi.restoreAllMocks() })

    it('a double-click on a dimension label opens its editor', async () => {
      const onDoubleClick = vi.fn()
      registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick: () => {}, onDoubleClick, onPointerDown: () => {} })
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 1, layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1', distancePx: 0,
      })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('dblclick', { button: 0, clientX: 120, clientY: 80 }))
      })

      expect(onDoubleClick).toHaveBeenCalledWith(120, 80)
    })

    it('a double-click on a feature handle opens its editor', async () => {
      const onDoubleClick = vi.fn()
      registerFeatureHandleCallbacks('fhandle:extrude1', { onPointerDown: () => {}, onDoubleClick })
      pipeline.resolveSync = vi.fn().mockReturnValue({
        id: 1, layer: FEATURE_HANDLE_LAYER_NAME, entityKey: 'fhandle:extrude1', distancePx: 0,
      })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('dblclick', { button: 0, clientX: 40, clientY: 60 }))
      })

      expect(onDoubleClick).toHaveBeenCalledWith(40, 60)
    })

    it('ignores a non-primary double-click and a double-click over empty space', async () => {
      const onDoubleClick = vi.fn()
      registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick: () => {}, onDoubleClick, onPointerDown: () => {} })
      pipeline.resolveSync = vi.fn().mockReturnValue(null)

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('dblclick', { button: 2, clientX: 1, clientY: 1 }))
      })
      expect(pipeline.resolveSync).not.toHaveBeenCalled()

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('dblclick', { button: 0, clientX: 1, clientY: 1 }))
      })
      expect(onDoubleClick).not.toHaveBeenCalled()
    })
  })

  it('a body-edge click while dimensioning inside a sketch projects it as a dim pick', async () => {
    // Faces are excluded: a face lowers to a whole wire, naming no single dim
    // target, so only edge/vertex hits take the project-as-dim path.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 7, layer: EDGE_LAYER_NAME, entityKey: '?03;abc:edge', pickKey: 'b#edge#0', distancePx: 0,
    })
    useSketchEditorStore.setState({ activeTool: 'dimension', activeFeatureId: 'feat1' })
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'addBrepDimensionPick')

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([EDGE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(spy).toHaveBeenCalledWith('?03;abc:edge', { isVertexPick: false, sourceKind: null })
    spy.mockRestore()
  })

  it('a B-rep face click under the dimension tool falls through to the generic selection toggle (pinned decision)', async () => {
    // isBrepDimensionPick excludes faces on purpose: a face lowers to a whole
    // wire, naming no single dim target. So a face click while dimensioning is
    // not consumed; it toggles normalSelection like any idle-tool face click.
    // Pinned here so the intended behavior is explicit rather than incidental.
    // It holds only with no picks pending: once a dimension waits for its
    // placement click, a face is backdrop and places it (test below).
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 8, layer: FACE_LAYER_NAME, entityKey: '@feat1/face/0', pickKey: '@feat1/face/0', distancePx: 0,
    })
    useSketchEditorStore.setState({
      activeTool: 'dimension', activeFeatureId: 'feat1',
      normalSelection: new Set(), dimensionPicks: [],
    })
    const dimSpy = vi.spyOn(useSketchEditorStore.getState(), 'addBrepDimensionPick')

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(dimSpy).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('@feat1/face/0')).toBe(true)
    dimSpy.mockRestore()
  })

  it('an origin click while dimensioning inside a sketch records a builtin vertex pick', async () => {
    // The origin is a legitimate dimension target (resolveDimension's
    // two_vertices path and DimensionTool's @builtin_ branch both accept it).
    // It resolves on the origin layer, which the dispatcher must route through
    // the sketch-click path while the dimension tool is armed instead of
    // toggling it into the normal selection.
    initializeTools()
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 13, layer: ORIGIN_LAYER_NAME, entityKey: '@builtin_origin', pickKey: '@builtin_origin', distancePx: 0,
    })
    useSketchEditorStore.setState({
      activeTool: 'dimension', activeFeatureId: 'feat1',
      normalSelection: new Set(), dimensionPicks: [],
    })
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'addDimensionPick')

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([ORIGIN_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(spy).toHaveBeenCalledWith({ isVertex: true, target: '@builtin_origin', entityKind: null })
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_origin')).toBe(false)
    spy.mockRestore()
  })

  it('a click over a document plane while dimensioning places the dimension like empty space', async () => {
    // Regression: the planes fill most of the view behind a sketch. Resolved as
    // a plane hit, the placement click toggled the plane into the selection and
    // the dimension never committed. The resolver stub honours the allowed set
    // the way the real pipeline does: the plane is under the cursor, so it only
    // answers when the active tool lets the plane layer through.
    pipeline.resolveSync = vi.fn((_gl, _cursor, opts?: { allowedLayers?: ReadonlySet<string> }) => (
      opts?.allowedLayers?.has(PLANE_LAYER_NAME)
        ? { id: 3, layer: PLANE_LAYER_NAME, entityKey: '@builtin_plane_top', pickKey: '@builtin_plane_top', distancePx: 0 }
        : null
    )) as unknown as IdPipeline['resolveSync']
    pipeline.target.markClean()
    useSketchEditorStore.setState({
      activeTool: 'dimension', activeFeatureId: 'feat1',
      normalSelection: new Set(), dimensionPicks: [{ isVertex: false, target: 'entity:feat1:l1' }],
    })
    const finalize = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement').mockImplementation(() => {})

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(finalize).toHaveBeenCalledWith([100, 100])
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(false)
    finalize.mockRestore()
  })

  it.each([
    ['a sketch region', SKETCH_SURFACE_LAYER_NAME, 'sk1/surf:face0'],
    ['a body face', FACE_LAYER_NAME, '@feat0/face/0'],
  ])('a placement click over %s places the pending dimension instead of selecting the area', async (_label, layer, key) => {
    // Areas rank above the planes and below sketch geometry, so a hit on one
    // means no curve or point was within reach: the label of a circle's
    // diameter lands inside the region it measures.
    pipeline.resolveSync = vi.fn().mockReturnValue({ id: 4, layer, entityKey: key, pickKey: key, distancePx: 0 })
    useSketchEditorStore.setState({
      activeTool: 'dimension', activeFeatureId: 'feat1',
      normalSelection: new Set(), dimensionPicks: [{ isVertex: false, target: 'entity:feat1:c1' }],
    })
    const finalize = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement').mockImplementation(() => {})

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([layer]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(finalize).toHaveBeenCalledWith([100, 100])
    expect(useSketchEditorStore.getState().normalSelection.has(key)).toBe(false)
    finalize.mockRestore()
  })

  it('an origin click outside the dimension tool still toggles the normal selection', async () => {
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 13, layer: ORIGIN_LAYER_NAME, entityKey: '@builtin_origin', pickKey: '@builtin_origin', distancePx: 0,
    })
    useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })

    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([ORIGIN_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_origin')).toBe(true)
  })
})
