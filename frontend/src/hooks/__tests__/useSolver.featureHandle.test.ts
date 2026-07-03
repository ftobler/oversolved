/**
 * Tests that applySolveResult propagates the kernel's `handle` descriptor for
 * brep feature results. The FeatureHandles arrow reads it from solveResults;
 * dropping it here (the worker -> store seam) silently disables all handles.
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
import type { PartDoc, BodyResult, FeatureHandleData } from '@/types/cad'

const EXTRUDE_HANDLE: FeatureHandleData = {
  kind: 'linear',
  field: 'distance',
  anchor: [0, 0, 10],
  direction: [0, 0, 1],
  value: 10,
  unit_scale: 1,
  min: 0,
}

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', initial: {} },
      { id: 'ex1', kind: 'extrude', extrude: { profile: 'sk1', distance: 10 } },
    ] as PartDoc['features'],
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

describe('applySolveResult -- handle descriptor on brep results', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores the handle when the brep result includes one', async () => {
    const result = setupHook()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: {
        ex1: {
          status: 'ok',
          body_id: 'body1',
          handle: EXTRUDE_HANDLE,
        },
      },
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })

    await act(async () => { await result.current.reSolve(makeDoc()) })

    expect(result.current.solveResults['ex1']).toBeDefined()
    expect(result.current.solveResults['ex1'].handle).toEqual(EXTRUDE_HANDLE)
  })

  it('does not set handle when the result omits it (e.g. up_to extrude)', async () => {
    const result = setupHook()
    mockSolveLocally.mockResolvedValue({
      solve_ms: 0,
      result: {
        ex1: {
          status: 'ok',
          body_id: 'body1',
        },
      },
      bodies: {} as Record<string, BodyResult>,
      _build_state: null,
    })

    await act(async () => { await result.current.reSolve(makeDoc()) })

    expect(result.current.solveResults['ex1']).toBeDefined()
    expect(result.current.solveResults['ex1'].handle).toBeUndefined()
  })
})
