import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback, useSketchUiStore } from '@/stores/sketchEditorStore'
import { useDimInteraction, useDimLabelPointerDown, type DimInteraction } from '../useDimInteraction'
import { COLOR_CONSTRAINT, COLOR_CONSTRAINT_DIM } from '@/utils/geometry/sketchHelpers'
import { COLOR_ERROR_DEEP } from '@/components/Geometry3D/constants'
import type { DragState } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'

const INTERACTION: DimInteraction = {
  featureId: 'S1',
  entityId: 'L1',
  constraintId: 'c1',
  promptLabel: 'Length',
}

function dimDrag(constraintId: string, startWorld: [number, number], currentWorld: [number, number]): DragState {
  return {
    type: 'dim_label',
    constraintId,
    featureId: 'S1',
    anchorWorld: [0, 0],
    startWorld,
    currentWorld,
  }
}

beforeEach(() => {
  useEditorState.setState({
    drag: null,
    dragPending: null,
    dragStartClient: null,
    isPointerDown: false,
    normalSelection: new Set(),
    hoveredConstraintEntityIds: new Set(),
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
  setSketchCallback('onMutation', null)
})

describe('useDimInteraction click / double-click', () => {
  it('a clean click selects this constraint and replaces the old selection', () => {
    useEditorState.setState({
    normalSelection: new Set(['entity:S1:L1']),
  })
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))

    act(() => result.current.onClick({ stopPropagation: vi.fn() }))

    expect(useSketchEditorStore.getState().normalSelection).toEqual(new Set(['constraint:S1:c1']))
    expect(result.current.selected).toBe(true)
  })

  it('suppresses the single click that follows a moved dim_label drag', () => {
    useEditorState.setState({
    normalSelection: new Set(['entity:S1:L1']),
  })
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))

    act(() => {
      useSketchEditorStore.getState().setDrag(dimDrag('c1', [1, 1], [3, 2]))
    })
    act(() => result.current.onClick({ stopPropagation: vi.fn() }))

    // Suppression means the old selection survives: an unsuppressed click would
    // have cleared it and selected `constraint:S1:c1` instead.
    expect(useSketchEditorStore.getState().normalSelection).toEqual(new Set(['entity:S1:L1']))
  })

  it('suppresses the double-click dialog that follows a moved dim_label drag', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))

    act(() => {
      useSketchEditorStore.getState().setDrag(dimDrag('c1', [1, 1], [3, 2]))
    })
    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 5, clientY: 6 }))

    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
  })

  it('does not suppress a drag that ended where it started', () => {
    useEditorState.setState({
    normalSelection: new Set(['entity:S1:L1']),
  })
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))

    act(() => {
      useSketchEditorStore.getState().setDrag(dimDrag('c1', [1, 1], [1, 1]))
    })
    act(() => result.current.onClick({ stopPropagation: vi.fn() }))

    expect(useSketchEditorStore.getState().normalSelection).toEqual(new Set(['constraint:S1:c1']))
  })

  it('a clean double-click opens the dialog with the label and displayed value', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 42, INTERACTION))

    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 5, clientY: 6 }))

    const dialog = useSketchUiStore.getState().pendingDialog
    expect(dialog).not.toBeNull()
    expect(dialog?.label).toBe('Length')
    expect(dialog?.defaultValue).toBe('42')
    expect(dialog?.position).toEqual([5, 6])
  })

  it('validate rejects non-numeric input and non-positive values when validatePositive', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION, true))
    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 }))
    const validate = useSketchUiStore.getState().pendingDialog!.validate!

    // The shared value rules' words, the same as a schema field's.
    expect(validate('abc')).toBe('Value refused: cannot evaluate "abc"')
    expect(validate('0')).toBe('Value refused: must be greater than 0')
    expect(validate('-5')).toBe('Value refused: must be greater than 0')
    expect(validate('12')).toBeNull()
  })

  it('validate accepts zero and negatives when validatePositive is false', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION, false))
    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 }))
    const validate = useSketchUiStore.getState().pendingDialog!.validate!

    expect(validate('0')).toBeNull()
    expect(validate('-5')).toBeNull()
  })

  it('dispatches the evaluated edited value with set_constraint_value', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))
    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 }))

    act(() => useSketchUiStore.getState().pendingDialog!.onConfirm('30'))

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_value',
      featureId: 'S1',
      constraintId: 'c1',
      value: 30,
    })
  })

  it('encodes the display value before it reaches the mutation', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const { result } = renderHook(() =>
      useDimInteraction('c1', 10, INTERACTION, true, undefined, (displayed) => 180 - displayed))
    act(() => result.current.onDoubleClick({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 }))

    act(() => useSketchUiStore.getState().pendingDialog!.onConfirm('30'))

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_value',
      featureId: 'S1',
      constraintId: 'c1',
      value: 150,
    })
  })
})

describe('useDimInteraction hover / isDragged', () => {
  it('hover highlights the interaction entity and clears it on out', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))
    const over = { stopPropagation: vi.fn() }

    act(() => result.current.onOver(over))
    expect(result.current.hovered).toBe(true)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['L1']))
    expect(over.stopPropagation).toHaveBeenCalled()

    act(() => result.current.onOut())
    expect(result.current.hovered).toBe(false)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set())
  })

  it('a culprit dimension paints the deeper error red, a redundant one dims', () => {
    const { result: culprit } = renderHook(() => useDimInteraction('c1', 10, { ...INTERACTION, culprit: true }))
    expect(culprit.current.color).toBe(COLOR_ERROR_DEEP)
    const { result: redundant } = renderHook(() => useDimInteraction('c1', 10, { ...INTERACTION, redundant: true }))
    expect(redundant.current.color).toBe(COLOR_CONSTRAINT_DIM)
    // Idle and clean: the normal constraint amber.
    const { result: clean } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))
    expect(clean.current.color).toBe(COLOR_CONSTRAINT)
  })

  it('selection and hover still outrank the verdict tint', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, { ...INTERACTION, culprit: true }))
    act(() => useSketchEditorStore.getState().setDrag(dimDrag('c1', [0, 0], [1, 1])))
    // hover is not touched by the drag; select via the hook's own click path.
    act(() => result.current.onOver({ stopPropagation: vi.fn() }))
    expect(result.current.color).toBe('#ffffff')
  })

  it('isDragged is true only for this constraint dim_label drag', () => {
    const { result } = renderHook(() => useDimInteraction('c1', 10, INTERACTION))
    expect(result.current.isDragged).toBe(false)

    act(() => useSketchEditorStore.getState().setDrag(dimDrag('c1', [0, 0], [1, 1])))
    expect(result.current.isDragged).toBe(true)

    act(() => useSketchEditorStore.getState().setDrag(dimDrag('c2', [0, 0], [1, 1])))
    expect(result.current.isDragged).toBe(false)

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
    expect(result.current.isDragged).toBe(false)
  })
})

describe('useDimLabelPointerDown', () => {
  it('seeds a dim_label dragPending with the anchor and start world and resets click suppression', () => {
    const resetDragMoved = vi.fn()
    const { result } = renderHook(() =>
      useDimLabelPointerDown('c1', INTERACTION, resetDragMoved, 3, 4, 7, 8))
    const stopPropagation = vi.fn()

    act(() => result.current({ stopPropagation, clientX: 100, clientY: 200 }))

    const state = useSketchEditorStore.getState()
    expect(resetDragMoved).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalled()
    expect(state.isPointerDown).toBe(true)
    expect(state.dragStartClient).toEqual([100, 200])
    expect(state.dragPending).toEqual({
      type: 'dim_label',
      constraintId: 'c1',
      featureId: 'S1',
      anchorWorld: [3, 4],
      startWorld: [7, 8],
    })
  })

  it('is inert without an interaction', () => {
    const resetDragMoved = vi.fn()
    const { result } = renderHook(() =>
      useDimLabelPointerDown('c1', undefined, resetDragMoved, 0, 0, 0, 0))
    const stopPropagation = vi.fn()

    act(() => result.current({ stopPropagation, clientX: 1, clientY: 2 }))

    expect(resetDragMoved).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().dragPending).toBeNull()
  })
})
