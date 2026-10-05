import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveLocally } = vi.hoisted(() => ({ mockSolveLocally: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveLocally }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

// A doc with one ported feature so reSolve routes through the local kernel.
function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { version: 1, kind: 'part', features: [{ id: 'feat1', kind: 'sketch', entities: [] }], ...overrides }
}

describe('useSolver solve-race guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stale resolve after a newer solve response is discarded', async () => {
    // A starts (requestId=1), B starts (requestId=2). A's response
    // arrives after B started. A must be discarded via isStale() guard.
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()

    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    let resolveA!: (v: unknown) => void
    let resolveB!: (v: unknown) => void
    mockSolveLocally
      .mockReturnValueOnce(new Promise(r => { resolveA = r }))
      .mockReturnValueOnce(new Promise(r => { resolveB = r }))

    let pA!: Promise<void>, pB!: Promise<void>
    act(() => { pA = result.current.reSolve(makeDoc()) })
    act(() => { pB = result.current.reSolve(makeDoc()) })

    // B resolves first (current requestId=2, B's requestId=2, not stale)
    await act(async () => {
      resolveB({
        solve_ms: 0,
        result: {},
        bodies: {},
        _build_state: null,
        request_version: 2,
      })
    })

    // A resolves second (requestId=1, current=2, stale)
    await act(async () => {
      resolveA({
        solve_ms: 0,
        result: { stale: { status: 'ok' } },
        bodies: {},
        _build_state: null,
        request_version: 1,
      })
      await Promise.all([pA, pB])
    })

    // Stale A result must not appear in solveResults
    expect(result.current.solveResults).not.toHaveProperty('stale')
    expect(result.current.solveError).toBeNull()
  })

  it('solve B that completes before A does not get overwritten', async () => {
    // Regression: after the first solve completes, B completes but A was still
    // in-flight. The isStale guard must prevent A from
    // overwriting B's result when A's worker response arrives.
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()

    const { result } = renderHook(() =>
      useSolver(undefined, {}, docRef, setDoc),
    )

    let resolveA!: (v: unknown) => void
    mockSolveLocally
      .mockReturnValueOnce(new Promise(r => { resolveA = r }))  // A in-flight
      .mockResolvedValue({  // B completes fast
        solve_ms: 0,
        result: { featB: { status: 'ok' } },
        bodies: {},
        _build_state: null,
        request_version: 2,
      })

    let pA!: Promise<void>, pB!: Promise<void>
    act(() => { pA = result.current.reSolve(makeDoc()) })
    act(() => { pB = result.current.reSolve(makeDoc()) })

    // Wait for B to finish
    await act(async () => { await pB })

    const solveResultsAfterB = { ...result.current.solveResults }

    // Now A's response arrives, must be discarded
    await act(async () => {
      resolveA({
        solve_ms: 0,
        result: { overwrite: { status: 'ok' } },
        bodies: {},
        _build_state: null,
        request_version: 1,
      })
      await pA
    })

    // A's stale result must NOT overwrite B's featB
    expect(result.current.solveResults).toEqual(solveResultsAfterB)
  })
})
