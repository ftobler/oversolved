import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolver } = vi.hoisted(() => ({
  mockSolver: { solve: vi.fn(), disconnect: vi.fn(), onGeometryUpdate: vi.fn().mockReturnValue(vi.fn()) },
}))
const { mockCache } = vi.hoisted(() => ({
  mockCache: {
    getCachedBuildResponse: vi.fn().mockResolvedValue(null),
    cacheBuildResponse: vi.fn().mockResolvedValue(undefined),
    cacheGeometry: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/hooks/solverWs', () => ({ solverWs: mockSolver }))
vi.mock('@/hooks/useGeometryCache', () => ({ useGeometryCache: vi.fn(() => mockCache) }))
vi.mock('@/utils/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/utils/geometryUnpack', () => ({
  unpackBodies: vi.fn().mockReturnValue({}),
  unpackPickBodies: vi.fn().mockReturnValue({}),
}))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc, BodyResult } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'sk1', kind: 'sketch', initial: { old_pt: [9, 9] } }],
  }
}

describe('useSolver doc integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.getCachedBuildResponse.mockResolvedValue(null)
    mockCache.cacheBuildResponse.mockResolvedValue(undefined)
    mockCache.cacheGeometry.mockResolvedValue(undefined)
  })

  it('does not mutate the doc reference passed to reSolve', async () => {
    mockSolver.solve.mockResolvedValue({
      solve_ms: 0,
      result: { sk1: { geometry: { new_pt: [1, 2] } } },
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })

    const docRef = { current: makeDoc() }
    const setDoc = vi.fn()
    const { result } = renderHook(() =>
      useSolver('test-uuid', vi.fn(), { current: 'feature' }, {}, docRef, setDoc),
    )

    const originalDoc = makeDoc()
    await act(async () => { await result.current.reSolve(originalDoc) })

    // original doc should be untouched
    expect(originalDoc.features![0].initial).toEqual({ old_pt: [9, 9] })

    // setDoc should have been called with a cloned doc carrying the new geometry
    expect(setDoc).toHaveBeenCalled()
    const savedDoc = setDoc.mock.calls[0][0] as PartDoc
    expect(savedDoc).not.toBe(originalDoc)
    expect(savedDoc.features![0].initial).toEqual({ new_pt: [1, 2] })
  })
})
