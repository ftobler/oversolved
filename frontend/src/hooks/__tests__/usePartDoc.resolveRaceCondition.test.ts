import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolver } = vi.hoisted(() => ({
  mockSolver: {
    solve: vi.fn(),
    disconnect: vi.fn(),
    onGeometryUpdate: vi.fn().mockReturnValue(vi.fn()),
  },
}))

const { mockCache } = vi.hoisted(() => ({
  mockCache: {
    getCachedBuildResponse: vi.fn(),
    cacheBuildResponse: vi.fn(),
    cacheGeometry: vi.fn(),
  },
}))

const { mockInvalidateDocCache } = vi.hoisted(() => ({
  mockInvalidateDocCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/hooks/solverWs', () => ({ solverWs: mockSolver }))
vi.mock('@/hooks/useGeometryCache', () => ({
  useGeometryCache: vi.fn(() => mockCache),
}))
vi.mock('@/utils/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/utils/geometryUnpack', () => ({
  unpackBodies: vi.fn().mockReturnValue({}),
  unpackPickBodies: vi.fn().mockReturnValue({}),
}))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))
vi.mock('@/utils/buildCache', () => ({
  invalidateDocCache: mockInvalidateDocCache,
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { oversolved: 1, kind: 'part', features: [], ...overrides }
}

describe('useSolver cache-race guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.getCachedBuildResponse.mockResolvedValue(null)
    mockCache.cacheBuildResponse.mockResolvedValue(undefined)
  })

  it('stale resolve after WebSocket response is discarded', async () => {
    // A starts (requestId=1), B starts (requestId=2). A's WS response
    // arrives after B started. A must be discarded via isStale() guard.
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()
    const modeRef = { current: 'feature' }
    const setCodeText = vi.fn()

    const { result } = renderHook(() =>
      useSolver(undefined, setCodeText, modeRef, {}, docRef, setDoc),
    )

    let resolveA!: (v: unknown) => void
    let resolveB!: (v: unknown) => void
    mockSolver.solve
      .mockReturnValueOnce(new Promise(r => { resolveA = r }))
      .mockReturnValueOnce(new Promise(r => { resolveB = r }))

    let pA!: Promise<void>, pB!: Promise<void>
    act(() => { pA = result.current.reSolve(makeDoc()) })
    act(() => { pB = result.current.reSolve(makeDoc()) })

    // B resolves first (current requestId=2, B's requestId=2 — not stale)
    await act(async () => {
      resolveB({
        solve_ms: 0,
        result: {},
        bodies: {},
        _build_state: null,
        request_version: 2,
      })
    })

    // A resolves second (requestId=1, current=2 — stale)
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
    // Regression: after cacheBuildResponse, B completes but A was still
    // in-flight. The guard after cacheBuildResponse must prevent A from
    // overwriting B's result when A's WS response arrives.
    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()
    const modeRef = { current: 'feature' }
    const setCodeText = vi.fn()

    const { result } = renderHook(() =>
      useSolver(undefined, setCodeText, modeRef, {}, docRef, setDoc),
    )

    let resolveA!: (v: unknown) => void
    mockSolver.solve
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

    // Now A's response arrives — must be discarded
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
