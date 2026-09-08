/**
 * A solve the Worker flushed out of its queue (a newer solve replaced it before
 * it ever ran) rejects with SUPERSEDED_ERROR. That is queue bookkeeping, not a
 * document failure: it must never reach the error banner, and it must not clear
 * the solving flag out from under the newer solve that replaced it.
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
import { SUPERSEDED_ERROR } from '@/kernel/worker/solverProtocol'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return { oversolved: 1, kind: 'part', features: [{ id: 'feat1', kind: 'sketch', entities: [] }] }
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const { result } = renderHook(() =>
    useSolver(undefined, {}, docRef, vi.fn()),
  )
  return result
}

describe('useSolver superseded solve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not surface a flushed solve as a document error', async () => {
    const result = setupHook()
    mockSolveViaWorker
      .mockRejectedValueOnce(new Error(SUPERSEDED_ERROR))
      .mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })

    let flushed!: Promise<void>
    act(() => { flushed = result.current.reSolve(makeDoc()) })
    await act(async () => {
      await result.current.reSolve(makeDoc())
      await flushed
    })

    expect(result.current.solveError).toBeNull()
  })

  it('leaves the solving flag to the newer solve that replaced it', async () => {
    const result = setupHook()
    let releaseFresh!: (v: unknown) => void
    mockSolveViaWorker
      .mockRejectedValueOnce(new Error(SUPERSEDED_ERROR))
      .mockReturnValueOnce(new Promise(r => { releaseFresh = r }))

    let flushed!: Promise<void>, fresh!: Promise<void>
    act(() => { flushed = result.current.reSolve(makeDoc()) })
    act(() => { fresh = result.current.reSolve(makeDoc()) })
    await act(async () => { await flushed })

    // The flushed solve settled, but the fresh one is still in flight.
    expect(result.current.solving).toBe(true)

    await act(async () => {
      releaseFresh({ solve_ms: 0, result: {}, bodies: {}, _build_state: null })
      await fresh
    })
    expect(result.current.solving).toBe(false)
  })

  it('still reports a genuine solver failure', async () => {
    const result = setupHook()
    mockSolveViaWorker.mockRejectedValue(new Error('kernel boom'))

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toContain('kernel boom')
  })
})
