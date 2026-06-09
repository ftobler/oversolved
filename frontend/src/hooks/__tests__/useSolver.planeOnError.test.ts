/**
 * Tests that applySolveResult propagates plane_transform from error responses (feature 277).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveLocally } = vi.hoisted(() => ({ mockSolveLocally: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveLocally }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc, BodyResult } from '@/types/cad'

const FRONT_TRANSFORM = {
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  origin: [0, 0, 0],
}

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', initial: {} }],
  }
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const setDoc = vi.fn()
  const { result } = renderHook(() =>
    useSolver(undefined, vi.fn(), { current: 'feature' }, {}, docRef, setDoc),
  )
  return result
}

describe('applySolveResult -- plane_transform on error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores plane_transform when error response includes it', async () => {
    const result = setupHook()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: {
        sk1: {
          status: 'exception',
          exception: 'something went wrong',
          plane_transform: FRONT_TRANSFORM,
        },
      },
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })

    await act(async () => { await result.current.reSolve(makeDoc()) })

    expect(result.current.solveResults['sk1']).toBeDefined()
    expect(result.current.solveResults['sk1'].plane_transform).toEqual(FRONT_TRANSFORM)
  })

  it('does not set plane_transform when error response omits it', async () => {
    const result = setupHook()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: {
        sk1: {
          status: 'exception',
          exception: 'something went wrong',
        },
      },
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })

    await act(async () => { await result.current.reSolve(makeDoc()) })

    expect(result.current.solveResults['sk1']).toBeDefined()
    expect(result.current.solveResults['sk1'].plane_transform).toBeUndefined()
  })
})
