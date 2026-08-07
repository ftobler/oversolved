/**
 * `pickStateReady` reports whether the two-world (ghost) state actually exists:
 * entering a feature edit flips the editor store immediately, but the pick
 * bodies only arrive with the solve that was asked for them. A ghost preview
 * drawn in that gap has no "before" state to subtract and paints the whole
 * model as new geometry, so the flag must stay false until the solve lands.
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
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    oversolved: 1,
    kind: 'part',
    features: [
      { id: 'ex1', kind: 'extrude' },
      { id: 'db1', kind: 'delete_body', delete_body: { bodies: [] } },
    ],
  } as unknown as PartDoc
}

function setupHook() {
  const docRef = { current: makeDoc() }
  const { result } = renderHook(() =>
    useSolver(undefined, vi.fn(), { current: 'feature' }, {}, docRef, vi.fn()),
  )
  return result
}

/** The editor store as enterEditFeature leaves it for the delete_body feature. */
function enterEditOfDeleteBody() {
  usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: 2, pickBoundary: 1 })
}

/** The editor store as enterEditFeature leaves it for the FIRST non-sketch feature. */
function enterEditOfFirstFeature() {
  usePartEditorStore.setState({ editingFeatureId: 'ex1', rollbackPosition: 1, pickBoundary: 0 })
}

describe('useSolver pick state readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  })

  it('is false before any solve', () => {
    const result = setupHook()
    expect(result.current.pickStateReady).toBe(false)
  })

  it('stays false while the edit solve is still in flight', async () => {
    const result = setupHook()
    enterEditOfDeleteBody()
    let release!: (v: unknown) => void
    mockSolveViaWorker.mockReturnValueOnce(new Promise(r => { release = r }))

    let pending!: Promise<void>
    act(() => { pending = result.current.reSolve(makeDoc()) as Promise<void> })
    expect(result.current.pickStateReady).toBe(false)

    await act(async () => {
      release({ solve_ms: 0, result: {}, bodies: { body_ex1: {} }, pick_bodies: { body_ex1: {} }, _build_state: null })
      await pending
    })
    expect(result.current.pickStateReady).toBe(true)
    expect(result.current.pickBodies).toEqual({ body_ex1: {} })
  })

  it('goes false again when the edit ends', async () => {
    const result = setupHook()
    enterEditOfDeleteBody()
    mockSolveViaWorker.mockResolvedValueOnce({
      solve_ms: 0, result: {}, bodies: {}, pick_bodies: { body_ex1: {} }, _build_state: null,
    })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.pickStateReady).toBe(true)

    act(() => { usePartEditorStore.setState({ pickBoundary: null, rollbackPosition: null }) })
    expect(result.current.pickStateReady).toBe(false)
  })

  it('engages the editing world with empty pick bodies for pickBoundary=0', async () => {
    // Editing the first non-builtin, non-sketch feature requests boundary 0,
    // whose "before" state is the empty doc. The mocked response carries {} to
    // pin the main-thread contract: boundary 0 must still transition to
    // 'editing' (previously the key was absent and the world fell back to
    // 'full', never engaging ghost/pick state).
    const result = setupHook()
    enterEditOfFirstFeature()
    mockSolveViaWorker.mockResolvedValueOnce({
      solve_ms: 0, result: {}, bodies: { body_ex1: {} }, pick_bodies: {}, _build_state: null,
    })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.pickStateReady).toBe(true)
    expect(result.current.pickBodies).toEqual({})
  })

  it('stays false for a solve outside an edit', async () => {
    const result = setupHook()
    mockSolveViaWorker.mockResolvedValueOnce({ solve_ms: 0, result: {}, bodies: { body_ex1: {} }, _build_state: null })
    await act(async () => { await result.current.reSolve(makeDoc()) })
    expect(result.current.pickStateReady).toBe(false)
  })
})
