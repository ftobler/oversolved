// Logic tests for useWasmDragSolve: engagement, dirty-flag rAF throttling,
// warm-start chaining, and the dragSolveRegistry hand-off to pointer-up.
// The kernel module is mocked; the real solve math is covered by
// kernel/features/sketchDrag.test.ts against the real WASM solver.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockInit, mockReady, mockPrepare, mockSolve } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(null),
  mockReady: vi.fn().mockReturnValue(true),
  mockPrepare: vi.fn(),
  mockSolve: vi.fn(),
}))

// Spread the actual module: the global test-setup uses its setSketchTopology.
vi.mock('@/kernel/features/sketch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/kernel/features/sketch')>()
  return {
    ...actual,
    initSketchSolver: mockInit,
    isSketchSolverReady: mockReady,
    prepareDragContext: mockPrepare,
    solveSketchDrag: mockSolve,
  }
})

import { useWasmDragSolve } from '@/hooks/useWasmDragSolve'
import { getLastDragSolve, setLastDragSolve } from '@/components/Geometry3D/dragSolveRegistry'
import type { DragState } from '@/stores/sketchEditorStore'
import type { PartFeature, Sketch } from '@/types/cad'

const featureDef = { id: 'S1', kind: 'sketch', entities: [{ id: 'L1', kind: 'line' }] } as unknown as PartFeature

function vertexDrag(currentWorld: [number, number]): DragState {
  return {
    type: 'vertex',
    vertexId: 'vertex:S1:L1:start',
    featureId: 'S1',
    entityId: 'L1',
    vertexKey: 'start',
    startWorld: [0, 0],
    currentWorld,
    startClient: [100, 100],
  } as DragState
}

const fakeCtx = {
  input: { entities: [], params: [0, 0, 10, 0], pinnedMask: [], equalityPins: [], constraints: [], options: { dragMode: true, dragAnchorId: 0, skipStatusPass: true } },
  layout: [{ id: 'L1', kind: 'line', offset: 0, size: 4 }],
  params0: [0, 0, 10, 0],
  cursorIndices: [0, 1] as [number, number],
  isEdgeDrag: false,
  entityParamOffset: 0,
  entityCoordPairs: [] as [number, number][],
}

const fakeEdgeCtx = {
  ...fakeCtx,
  isEdgeDrag: true,
  entityCoordPairs: [[0, 1], [2, 3]] as [number, number][],
}

function edgeDrag(currentWorld: [number, number], startWorld: [number, number] = [0, 0]): DragState {
  return {
    type: 'edge',
    vertexId: 'entity:S1:L1',
    featureId: 'S1',
    entityId: 'L1',
    vertexKey: '',
    startWorld,
    currentWorld,
    startClient: [100, 100],
  } as DragState
}

function solveResult(params: number[]) {
  return {
    sketch: { L1: { start: [params[0], params[1]], end: [params[2], params[3]] } } as unknown as Sketch,
    geometry: { L1: [...params] },
    params,
    status: 'underconstrained',
  }
}

// Controlled rAF: callbacks queue up and run only when pump()ed.
let rafQueue: FrameRequestCallback[] = []
function pump(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    const cbs = rafQueue
    rafQueue = []
    act(() => { cbs.forEach((cb) => cb(0)) })
  }
}

beforeEach(() => {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  mockPrepare.mockReset().mockReturnValue(fakeCtx)
  mockSolve.mockReset().mockReturnValue(solveResult([1, 1, 10, 0]))
  mockReady.mockReset().mockReturnValue(true)
  setLastDragSolve(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useWasmDragSolve', () => {
  it('is not engaged without a drag', () => {
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: null, isDraggingThis: false }))
    expect(result.current.engaged).toBe(false)
    expect(result.current.sketch).toBeNull()
    expect(mockPrepare).not.toHaveBeenCalled()
  })

  it('engages synchronously on the first render that sees a vertex drag (no fallback flash)', () => {
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: vertexDrag([1, 1]), isDraggingThis: true }))
    // Engaged before any rAF tick -- the caller must not show a fallback frame 0.
    expect(result.current.engaged).toBe(true)
    expect(result.current.sketch).toBeNull()
    expect(mockPrepare).toHaveBeenCalledWith(featureDef, 'L1', 'start', [0, 0])
  })

  it('does not engage when the context cannot be built (unmapped vertex)', () => {
    mockPrepare.mockReturnValue(null)
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: vertexDrag([1, 1]), isDraggingThis: true }))
    expect(result.current.engaged).toBe(false)
    pump(2)
    expect(mockSolve).not.toHaveBeenCalled()
  })

  it('does not engage while the solver WASM is still loading', () => {
    mockReady.mockReturnValue(false)
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: vertexDrag([1, 1]), isDraggingThis: true }))
    expect(result.current.engaged).toBe(false)
    expect(mockInit).toHaveBeenCalled()
  })

  it('solves on the first frame and publishes preview + registry', () => {
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: vertexDrag([1, 1]), isDraggingThis: true }))
    pump()
    expect(mockSolve).toHaveBeenCalledTimes(1)
    // Frame 0 warm-starts from params0 with the current cursor.
    expect(mockSolve).toHaveBeenCalledWith(fakeCtx, fakeCtx.params0, [1, 1])
    expect(result.current.sketch).not.toBeNull()
    expect(getLastDragSolve()).toEqual({ featureId: 'S1', geometry: { L1: [1, 1, 10, 0] } })
  })

  it('dirty flag: an unmoved cursor never re-solves', () => {
    renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: vertexDrag([1, 1]), isDraggingThis: true }))
    pump(4)
    expect(mockSolve).toHaveBeenCalledTimes(1)
  })

  it('warm-starts each frame from the previous frame solution', () => {
    const { rerender } = renderHook(
      ({ drag }) => useWasmDragSolve({ featureId: 'S1', featureDef, drag, isDraggingThis: true }),
      { initialProps: { drag: vertexDrag([1, 1]) } },
    )
    pump()
    mockSolve.mockReturnValue(solveResult([2, 2, 10, 0]))
    rerender({ drag: vertexDrag([2, 2]) })
    pump()
    expect(mockSolve).toHaveBeenCalledTimes(2)
    // Frame 2 seeds from frame 1's params, not from params0.
    expect(mockSolve).toHaveBeenLastCalledWith(fakeCtx, [1, 1, 10, 0], [2, 2])
  })

  it('holds the last preview on a failed frame', () => {
    const { result, rerender } = renderHook(
      ({ drag }) => useWasmDragSolve({ featureId: 'S1', featureDef, drag, isDraggingThis: true }),
      { initialProps: { drag: vertexDrag([1, 1]) } },
    )
    pump()
    const held = result.current.sketch
    mockSolve.mockReturnValue(null)
    rerender({ drag: vertexDrag([3, 3]) })
    pump()
    expect(result.current.sketch).toBe(held)
    // The registry also still carries the last good frame.
    expect(getLastDragSolve()).toEqual({ featureId: 'S1', geometry: { L1: [1, 1, 10, 0] } })
  })

  it('clears preview and registry when the drag ends', () => {
    const { result, rerender } = renderHook(
      ({ drag, dragging }) => useWasmDragSolve({ featureId: 'S1', featureDef, drag, isDraggingThis: dragging }),
      { initialProps: { drag: vertexDrag([1, 1]) as DragState | null, dragging: true } },
    )
    pump()
    expect(getLastDragSolve()).not.toBeNull()
    rerender({ drag: null, dragging: false })
    expect(result.current.engaged).toBe(false)
    expect(result.current.sketch).toBeNull()
    expect(getLastDragSolve()).toBeNull()
  })

  // ── Edge/entity drag tests ──────────────────────────────────────────

  it('engages for edge drags too', () => {
    mockPrepare.mockReturnValue(fakeEdgeCtx)
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: edgeDrag([3, 4]), isDraggingThis: true }))
    expect(result.current.engaged).toBe(true)
    expect(result.current.sketch).toBeNull()
    // prepareDragContext called with null vertexKey for edge drags.
    expect(mockPrepare).toHaveBeenCalledWith(featureDef, 'L1', null, [0, 0])
  })

  it('solves edge drags with delta (not cursor pin)', () => {
    mockPrepare.mockReturnValue(fakeEdgeCtx)
    mockSolve.mockReturnValue(solveResult([3, 4, 13, 4]))
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: edgeDrag([3, 4], [0, 0]), isDraggingThis: true }))
    pump()
    expect(mockSolve).toHaveBeenCalledTimes(1)
    // Edge drag passes delta=[3,4] = cursorWorld - startWorld.
    expect(mockSolve).toHaveBeenCalledWith(fakeEdgeCtx, fakeEdgeCtx.params0, [3, 4], [3, 4])
    expect(result.current.sketch).not.toBeNull()
    expect(getLastDragSolve()).toEqual({ featureId: 'S1', geometry: { L1: [3, 4, 13, 4] } })
  })

  it('does not engage for edge drag when the context cannot be built', () => {
    mockPrepare.mockReturnValue(null)
    const { result } = renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: edgeDrag([3, 4]), isDraggingThis: true }))
    expect(result.current.engaged).toBe(false)
    pump(2)
    expect(mockSolve).not.toHaveBeenCalled()
  })

  it('dirty flag works for edge drags too', () => {
    mockPrepare.mockReturnValue(fakeEdgeCtx)
    renderHook(() =>
      useWasmDragSolve({ featureId: 'S1', featureDef, drag: edgeDrag([3, 4]), isDraggingThis: true }))
    pump(4)
    expect(mockSolve).toHaveBeenCalledTimes(1)
  })

  it('holds last preview on a failed edge drag frame', () => {
    mockPrepare.mockReturnValue(fakeEdgeCtx)
    // First frame succeeds with translated geometry.
    mockSolve.mockReturnValue(solveResult([3, 4, 13, 4]))
    const { result, rerender } = renderHook(
      ({ drag }) => useWasmDragSolve({ featureId: 'S1', featureDef, drag, isDraggingThis: true }),
      { initialProps: { drag: edgeDrag([3, 4]) } },
    )
    pump()
    const held = result.current.sketch
    expect(held).not.toBeNull()
    expect(getLastDragSolve()).toEqual({ featureId: 'S1', geometry: { L1: [3, 4, 13, 4] } })
    // Second frame fails.
    mockSolve.mockReturnValue(null)
    rerender({ drag: edgeDrag([5, 6]) })
    pump()
    expect(result.current.sketch).toBe(held)
    // Registry still carries the last good frame.
    expect(getLastDragSolve()).toEqual({ featureId: 'S1', geometry: { L1: [3, 4, 13, 4] } })
  })

  it('clears edge drag state on end', () => {
    mockPrepare.mockReturnValue(fakeEdgeCtx)
    const { result, rerender } = renderHook(
      ({ drag, dragging }) => useWasmDragSolve({ featureId: 'S1', featureDef, drag, isDraggingThis: dragging }),
      { initialProps: { drag: edgeDrag([3, 4]) as DragState | null, dragging: true } },
    )
    pump()
    expect(getLastDragSolve()).not.toBeNull()
    rerender({ drag: null, dragging: false })
    expect(result.current.engaged).toBe(false)
    expect(result.current.sketch).toBeNull()
    expect(getLastDragSolve()).toBeNull()
  })
})
