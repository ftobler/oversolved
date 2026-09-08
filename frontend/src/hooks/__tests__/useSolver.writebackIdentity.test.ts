/**
 * ST-L1 regression: the solver write-back must not defeat the save identity
 * guard. applySolveResult used to mint a fresh doc object on every solve, so a
 * re-solve overlapping a save would swap docRef identity and stop the save from
 * clearing the dirty flag. A re-solve that re-derives identical geometry must
 * keep the prior doc object (no identity swap); a solve that actually changes
 * the doc still swaps it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    oversolved: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
      ],
      initial: {},
    }],
  }
}

function response(geom: Record<string, number[]>): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: { sk1: { status: 'ok', geometry: geom } },
    bodies: {},
    _build_state: null,
  }
}

describe('solver write-back preserves doc identity on unchanged geometry', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('keeps docRef identity across a re-solve that bakes identical geometry', async () => {
    const docRef: { current: PartDoc | null } = { current: makeDoc() }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const afterFirst = docRef.current
    expect(setDoc).toHaveBeenCalledTimes(1)

    // Second solve, identical geometry: must NOT swap identity.
    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(docRef.current).toBe(afterFirst)
    expect(setDoc).toHaveBeenCalledTimes(1)
  })

  it('still swaps identity when the solved geometry actually changes', async () => {
    const docRef: { current: PartDoc | null } = { current: makeDoc() }
    const setDoc = vi.fn((d: PartDoc | null | ((prev: PartDoc | null) => PartDoc | null)) => {
      docRef.current = typeof d === 'function' ? d(docRef.current) : d
    })
    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 1, 0], l2: [0, 5, 1, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    const afterFirst = docRef.current

    mockSolveViaWorker.mockResolvedValue(response({ l1: [0, 0, 2, 0], l2: [0, 5, 2, 5] }))
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(docRef.current).not.toBe(afterFirst)
    expect(setDoc).toHaveBeenCalledTimes(2)
  })
})
