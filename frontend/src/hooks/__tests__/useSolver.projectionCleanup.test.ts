/**
 * Regression tests for the dangling-projection cleanup in useSolver.
 *
 * When a sketch solve returns projection_errors, applyGeometryToFeature
 * removes the stale entities + dependent constraints, and reSolve triggers
 * one follow-up solve with the cleaned doc so the solver never re-sees those
 * entities. The cleanup re-solve does NOT recursively trigger again
 * (_isCleanupReSolve guard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn() }) },
}))

import { useSolver } from '@/hooks/useSolver'
import type { PartDoc } from '@/types/cad'

function makeDocWithProjection(): PartDoc {
  return {
    oversolved: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'proj1', kind: 'line', source: '?edge;line' },
      ],
      constraints: [
        { id: 'c_keep', kind: 'horizontal', target: '$line1' },
        { id: 'c_drop', kind: 'coincident', a: '$line1end', b: '$proj1start' },
      ],
      initial: {},
    }],
  }
}

function buildResponse(projectionErrors?: string[]) {
  return {
    solve_ms: 0,
    result: {
      sk1: {
        status: 'ok',
        geometry: { line1: [0, 0, 1, 0] },
        ...(projectionErrors ? { projection_errors: projectionErrors } : {}),
      },
    },
    bodies: {},
    _build_state: null,
  }
}

function setupHook() {
  const docRef: { current: PartDoc | null } = { current: makeDocWithProjection() }
  const setDoc = vi.fn((updater: unknown) => {
    if (typeof updater === 'function') {
      docRef.current = (updater as (d: PartDoc | null) => PartDoc)(docRef.current)
    } else {
      docRef.current = updater as PartDoc
    }
  })
  const modeRef = { current: 'feature' }
  const setCodeText = vi.fn()
  const { result, unmount } = renderHook(() =>
    useSolver(undefined, setCodeText, modeRef, {}, docRef, setDoc as never),
  )
  return { result, unmount, docRef, setDoc }
}

describe('useSolver projection cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('triggers a cleanup re-solve when projection_errors are present', async () => {
    const { result } = setupHook()

    // First solve: returns projection_errors -> cleanup + re-solve
    // Second solve (cleanup re-solve): no errors
    mockSolveViaWorker
      .mockResolvedValueOnce(buildResponse(['proj1']))
      .mockResolvedValueOnce(buildResponse())

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    // Exactly two solves: the original + one cleanup re-solve
    expect(mockSolveViaWorker).toHaveBeenCalledTimes(2)
    expect(result.current.solveError).toBeNull()
  })

  it('does not re-solve again after a cleanup re-solve (_isCleanupReSolve guard)', async () => {
    const { result } = setupHook()

    // Even if the cleanup re-solve also returns errors, no third solve fires
    mockSolveViaWorker
      .mockResolvedValueOnce(buildResponse(['proj1']))
      .mockResolvedValueOnce(buildResponse(['proj1']))

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(mockSolveViaWorker).toHaveBeenCalledTimes(2)
  })

  it('does not trigger a re-solve when there are no projection_errors', async () => {
    const { result } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse())

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(mockSolveViaWorker).toHaveBeenCalledTimes(1)
  })
})
