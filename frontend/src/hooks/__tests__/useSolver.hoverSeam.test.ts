/**
 * M1: the solve seam clears `selectedPicks` because a re-solve can re-tessellate
 * and shift a pickKey's positional index onto a different primitive. Hover is the
 * byte-identical live identity through the byte-identical builder
 * (hoverActiveFrom), so it must be cleared on the SAME seam -- click-select and
 * hover-highlight are one mechanism. The face-normal readout fields are left
 * alone (they re-resolve on the next hover).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: mockSolveViaWorker,
  cancelSolver: vi.fn(),
}))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'ex1', kind: 'extrude' }],
  } as unknown as PartDoc
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const { result } = renderHook(() =>
    useSolver(undefined, {}, docRef, vi.fn()),
  )
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  useSketchEditorStore.setState({
    hoveredSelectionId: null,
    hoveredPickKey: null,
    selectedPicks: new Map(),
  } as never)
})

describe('useSolver clears the hovered pick identity at the solve seam', () => {
  it('an applied solve clears the hovered pick identity', async () => {
    const result = setupHook()
    useSketchEditorStore.setState({
      hoveredSelectionId: '?edge_q',
      hoveredPickKey: 'ex1/body_ex1#edge#3',
    } as never)
    mockSolveViaWorker.mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
    expect(useSketchEditorStore.getState().hoveredPickKey).toBeNull()
  })

  it('clears the hover identity on the same solve it clears selectedPicks', async () => {
    const result = setupHook()
    useSketchEditorStore.setState({
      hoveredSelectionId: '?edge_q',
      hoveredPickKey: 'ex1/body_ex1#edge#3',
      selectedPicks: new Map([['?edge_q', new Set(['ex1/body_ex1#edge#3'])]]),
    } as never)
    mockSolveViaWorker.mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const s = useSketchEditorStore.getState()
    expect(s.selectedPicks.size).toBe(0)
    expect(s.hoveredSelectionId).toBeNull()
    expect(s.hoveredPickKey).toBeNull()
  })

  it('leaves the hovered face normal readout alone', async () => {
    const result = setupHook()
    useSketchEditorStore.setState({
      hoveredFaceNormal: [0, 0, 1],
      hoveredFaceCenter: [1, 2, 3],
    } as never)
    mockSolveViaWorker.mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const s = useSketchEditorStore.getState()
    expect(s.hoveredFaceNormal).toEqual([0, 0, 1])
    expect(s.hoveredFaceCenter).toEqual([1, 2, 3])
  })
})
