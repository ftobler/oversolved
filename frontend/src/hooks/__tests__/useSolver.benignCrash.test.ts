/**
 * The crash cooldown in solverClient rejects a solve issued within the window
 * with 'solver worker crashed (backoff)'. Both that and the plain crash string
 * are crash noise, not document errors: the trap is already surfaced by the
 * console error, and a drag burst over a trapping doc would otherwise repaint
 * the banner on every reSolve. Neither may reach the error banner.
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
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return { oversolved: 1, kind: 'part', features: [{ id: 'feat1', kind: 'sketch', entities: [] }] }
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const { result } = renderHook(() =>
    useSolver(undefined, vi.fn(), { current: 'feature' }, {}, docRef, vi.fn()),
  )
  return result
}

describe('useSolver benign crash strings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a worker crash rejection does not paint a banner', async () => {
    const result = setupHook()
    mockSolveViaWorker.mockRejectedValue(new Error('solver worker crashed'))

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBeNull()
    expect(result.current.solveResult).toBe('')
  })

  it('a cooldown backoff rejection does not paint a banner', async () => {
    const result = setupHook()
    mockSolveViaWorker.mockRejectedValue(new Error('solver worker crashed (backoff)'))

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBeNull()
    expect(result.current.solveResult).toBe('')
  })

  it('a genuinely non-benign failure still paints the banner', async () => {
    // Guards against the benign set growing to swallow real document errors.
    const result = setupHook()
    mockSolveViaWorker.mockRejectedValue(new Error('kernel boom'))

    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.solveError).toBe('Error: kernel boom')
  })
})
