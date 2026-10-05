/**
 * Regression tests for the solver write-back purity.
 *
 * The generic solve path is pure wrt the undoable doc: it adopts solved
 * geometry into feature.initial but never deletes flagged content or promotes
 * entity kinds. The superfluous/projection_error flags are solve-time facts and
 * live in solveResults; removing them is the explicit cleanup command's job, so
 * undo restores them and the re-solve does not re-delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker, cancelSolver: vi.fn() }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc } from '@/types/cad'

function makeDocWithProjection(): PartDoc {
  return {
    version: 1,
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
        { id: 'c_super', kind: 'coincident', a: '$line1end', b: '$proj1start' },
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
        constraints: {
          c_keep: { residual: 0, render: { kind: 'symbol_h', at: [0, 0], entity: 'line1' }, superfluous: false },
          c_super: { residual: 0, render: { kind: 'symbol_coincident', at: [0, 0], entity: 'line1' }, superfluous: true },
        },
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
  const { result, unmount } = renderHook(() =>
    useSolver(undefined, {}, docRef, setDoc as never),
  )
  return { result, unmount, docRef, setDoc }
}

describe('useSolver solve-path purity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('solves exactly once when projection_errors are present (no cleanup re-solve)', async () => {
    const { result } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse(['proj1']))

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(mockSolveViaWorker).toHaveBeenCalledTimes(1)
    expect(result.current.solveError).toBeNull()
  })

  it('keeps the flagged projection errors in solveResults, not deleted from the doc', async () => {
    const { result, setDoc } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse(['proj1']))

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(result.current.solveResults.sk1.projection_errors).toEqual(['proj1'])
    const savedDoc = setDoc.mock.calls[0][0] as PartDoc
    const feat = savedDoc.features![0]
    expect(feat.entities!.map(e => e.id)).toEqual(['line1', 'proj1'])
  })

  it('keeps superfluous constraints in the doc and flags them in solveResults', async () => {
    const { result, setDoc } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse())

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(result.current.solveResults.sk1.constraints!.c_super.superfluous).toBe(true)
    const savedDoc = setDoc.mock.calls[0][0] as PartDoc
    const feat = savedDoc.features![0]
    expect(feat.constraints!.map(c => c.id)).toEqual(['c_keep', 'c_super'])
  })

  it('does not carry projection_errors when the response has none', async () => {
    const { result } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse())

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(result.current.solveResults.sk1.projection_errors).toBeUndefined()
  })

  it('does not set the dirty flag (a clean doc saved after a rebuild stays clean)', async () => {
    const { result } = setupHook()

    mockSolveViaWorker.mockResolvedValueOnce(buildResponse(['proj1']))

    await act(async () => { await result.current.reSolve(makeDocWithProjection()) })

    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})
