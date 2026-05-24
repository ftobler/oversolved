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

function setupHook(uuid?: string) {
  const docRef = { current: makeDoc() }
  const setDoc = vi.fn()
  const modeRef = { current: 'feature' }
  const setCodeText = vi.fn()
  const { result, unmount } = renderHook(() =>
    useSolver(uuid, setCodeText, modeRef, {}, docRef, setDoc),
  )
  return { result, unmount, setDoc }
}

describe('useSolver requestId race guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.getCachedBuildResponse.mockResolvedValue(null)
    mockCache.cacheBuildResponse.mockResolvedValue(undefined)
  })

  it('stale solve is discarded when a newer solve starts before completion', async () => {
    const { result } = setupHook()

    let resolveV1!: (v: unknown) => void
    let resolveV2!: (v: unknown) => void
    const v1Promise = new Promise(r => { resolveV1 = r })
    const v2Promise = new Promise(r => { resolveV2 = r })

    mockSolver.solve
      .mockReturnValueOnce(v1Promise)
      .mockReturnValueOnce(v2Promise)

    let p1!: Promise<void>, p2!: Promise<void>
    act(() => { p1 = result.current.reSolve(makeDoc()) })
    act(() => { p2 = result.current.reSolve(makeDoc()) })

    // V1 resolves first but is stale (requestId moved to 2)
    const v1Response = {
      solve_ms: 0,
      result: { stale_feature: { status: 'ok' } },
      bodies: {},
      _build_state: null,
      request_version: 1,
    }
    await act(async () => { resolveV1(v1Response) })

    // V1 was stale — result must not appear
    expect(result.current.solveResults).not.toHaveProperty('stale_feature')

    // V2 (fresh) resolves
    const v2Response = {
      solve_ms: 0,
      result: {},
      bodies: {},
      _build_state: null,
      request_version: 2,
    }
    await act(async () => {
      resolveV2(v2Response)
      await Promise.all([p1, p2])
    })

    expect(result.current.solveError).toBeNull()
  })

  it('only the winning solve updates setDoc', async () => {
    const { result, setDoc } = setupHook()

    let resolveV1!: (v: unknown) => void
    const v1Promise = new Promise(r => { resolveV1 = r })
    mockSolver.solve.mockReturnValueOnce(v1Promise)

    let p1!: Promise<void>
    act(() => { p1 = result.current.reSolve(makeDoc()) })

    // V2 starts, bumping requestId
    let resolveV2!: (v: unknown) => void
    const v2Promise = new Promise(r => { resolveV2 = r })
    mockSolver.solve.mockReturnValueOnce(v2Promise)

    let p2!: Promise<void>
    act(() => { p2 = result.current.reSolve(makeDoc({ features: [{ id: 'f2', kind: 'extrude' }] })) })

    // Resolve V1 (stale)
    await act(async () => {
      resolveV1({
        solve_ms: 0,
        result: { v1_feat: { status: 'ok' } },
        bodies: {},
        _build_state: null,
        request_version: 1,
      })
    })

    const setDocCallsAfterV1 = setDoc.mock.calls.length

    // Resolve V2 (fresh)
    await act(async () => {
      resolveV2({
        solve_ms: 0,
        result: {},
        bodies: {},
        _build_state: null,
        request_version: 2,
      })
      await Promise.all([p1, p2])
    })

    // V2 should have called setDoc — V1's result was dropped
    expect(setDoc.mock.calls.length).toBeGreaterThan(setDocCallsAfterV1)
  })
})
