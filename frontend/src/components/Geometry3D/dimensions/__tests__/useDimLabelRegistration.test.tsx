import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { LABEL_Z_OFFSET } from '@/components/Geometry3D/constants'
import type { DragState } from '@/stores/sketchEditorStore'
import {
  useDimInteraction, useDimLabelRegistration, useActiveLabelDrag,
  type DimInteraction,
} from '../useDimInteraction'

// The registration hooks are seams: this test asserts the arguments the shared
// wrapper derives (enabled gate, label z-offset, handler wiring), not that the
// ID buffer itself allocates.
const seams = vi.hoisted(() => ({
  regLabel: vi.fn(),
  regDispatch: vi.fn(),
}))

vi.mock('@/picking/useDimensionLabelIdRegistration', () => ({
  useDimensionLabelIdRegistration: (args: unknown) => seams.regLabel(args),
}))
vi.mock('../useDimDispatchRegistration', () => ({
  useDimDispatchRegistration: (cid: string, handlers: unknown) => seams.regDispatch(cid, handlers),
}))

const INTERACTION: DimInteraction = {
  featureId: 'S1',
  entityId: 'L1',
  constraintId: 'c1',
  promptLabel: 'Length',
}

function dimDrag(constraintId: string, currentWorld: [number, number]): DragState {
  return {
    type: 'dim_label',
    constraintId,
    featureId: 'S1',
    anchorWorld: [0, 0],
    startWorld: [1, 1],
    currentWorld,
  }
}

beforeEach(() => {
  seams.regLabel.mockClear()
  seams.regDispatch.mockClear()
  useSketchEditorStore.setState({
    drag: null,
    dragPending: null,
    normalSelection: new Set(),
    pendingDialog: null,
  })
})

describe('useActiveLabelDrag', () => {
  it('is null with no drag', () => {
    const { result } = renderHook(() => useActiveLabelDrag('c1'))
    expect(result.current).toBeNull()
  })

  it('returns the live label position for this constraint', () => {
    const { result } = renderHook(() => useActiveLabelDrag('c1'))
    act(() => useSketchEditorStore.getState().setDrag(dimDrag('c1', [3, 4])))
    expect(result.current).toEqual([3, 4])
  })

  it('is null for a different constraint or a non-label drag', () => {
    const { result } = renderHook(() => useActiveLabelDrag('c1'))
    act(() => useSketchEditorStore.getState().setDrag(dimDrag('c2', [3, 4])))
    expect(result.current).toBeNull()

    act(() => useSketchEditorStore.getState().setDrag({
      type: 'vertex',
      vertexId: 'entity:S1:L1',
      featureId: 'S1',
      entityId: 'L1',
      vertexKey: 'start',
      startWorld: [0, 0],
      currentWorld: [1, 1],
      startClient: [0, 0],
    }))
    expect(result.current).toBeNull()
  })
})

describe('useDimLabelRegistration', () => {
  const handlers = {
    onOver: vi.fn(),
    onOut: vi.fn(),
    onDoubleClick: vi.fn(),
    onPointerDown: vi.fn(),
  }

  it('registers the label at its position and enables it only with an interaction', () => {
    renderHook(() => useDimLabelRegistration({
      cid: 'c1', interaction: INTERACTION, isDragged: false, labelX: 7, labelY: 8,
      onOver: handlers.onOver, onOut: handlers.onOut,
      onDoubleClick: handlers.onDoubleClick, onPointerDown: handlers.onPointerDown,
    }))

    expect(seams.regLabel).toHaveBeenCalledWith({
      constraintId: 'c1',
      position: [7, 8, LABEL_Z_OFFSET],
      enabled: true,
      planeTransform: undefined,
    })
  })

  it('disables registration while the label is being dragged', () => {
    renderHook(() => useDimLabelRegistration({
      cid: 'c1', interaction: INTERACTION, isDragged: true, labelX: 0, labelY: 0,
      onOver: handlers.onOver, onOut: handlers.onOut,
      onDoubleClick: handlers.onDoubleClick, onPointerDown: handlers.onPointerDown,
    }))

    expect(seams.regLabel.mock.calls[0][0]).toMatchObject({ enabled: false })
  })

  it('disables registration without an interaction', () => {
    renderHook(() => useDimLabelRegistration({
      cid: 'c1', interaction: undefined, isDragged: false, labelX: 0, labelY: 0,
      onOver: handlers.onOver, onOut: handlers.onOut,
      onDoubleClick: handlers.onDoubleClick, onPointerDown: handlers.onPointerDown,
    }))

    expect(seams.regLabel.mock.calls[0][0]).toMatchObject({ enabled: false })
  })

  it('forwards the interaction handlers to the dispatcher with an inert click', () => {
    renderHook(() => useDimLabelRegistration({
      cid: 'c1', interaction: INTERACTION, isDragged: false, labelX: 0, labelY: 0,
      onOver: handlers.onOver, onOut: handlers.onOut,
      onDoubleClick: handlers.onDoubleClick, onPointerDown: handlers.onPointerDown,
    }))

    expect(seams.regDispatch).toHaveBeenCalledTimes(1)
    const [cid, dispatched] = seams.regDispatch.mock.calls[0]
    expect(cid).toBe('c1')
    expect(dispatched).toMatchObject({
      onOver: handlers.onOver,
      onOut: handlers.onOut,
      onDoubleClick: handlers.onDoubleClick,
      onPointerDown: handlers.onPointerDown,
    })
    // Single-click selection rides the label mesh itself; the dispatched click
    // must be a no-op, not a second selection path.
    expect(dispatched.onClick()).toBeUndefined()
  })
})

describe('useDimInteraction without an interaction', () => {
  it('click and double-click are inert', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['entity:S1:L1']) })
    const { result } = renderHook(() => useDimInteraction('c1', 10, undefined))

    expect(() => result.current.onClick({ stopPropagation: vi.fn() })).not.toThrow()
    expect(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 })).not.toThrow()

    expect(useSketchEditorStore.getState().normalSelection).toEqual(new Set(['entity:S1:L1']))
    expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
  })

  it('exposes a null selection key so it is never marked selected', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['constraint:S1:c1']) })
    const { result } = renderHook(() => useDimInteraction('c1', 10, undefined))
    expect(result.current.selected).toBe(false)
  })
})
