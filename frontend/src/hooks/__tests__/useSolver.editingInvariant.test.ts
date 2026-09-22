// assertEditingInvariant guards the pick/edit seam: the rollback and pick
// boundary the solve is about to run with must match the feature being edited.
// A desync (an undo, a stale add+enter) must surface as a solver error instead
// of quietly solving against the wrong checkpoint. These drive both checks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue(null),
  cancelSolver: vi.fn(),
}))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

import { useSolver } from '@/hooks/useSolver'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc } from '@/types/cad'

const DOC = {
  version: 1,
  kind: 'part',
  features: [{ id: 'ex1', kind: 'extrude', extrude: { profile: 'sk1', distance: 1 } }],
} as unknown as PartDoc

function resetStore(): void {
  usePartEditorStore.setState({ editingFeatureId: null, pickBoundary: null, rollbackPosition: null })
}

async function solveWithStore(doc: PartDoc): Promise<ReturnType<typeof useSolver>> {
  const docRef = { current: doc }
  const { result } = renderHook(() => useSolver(undefined, {}, docRef, vi.fn()))
  await act(async () => { await result.current.reSolve(doc) })
  return result.current
}

describe('assertEditingInvariant', () => {
  beforeEach(() => act(resetStore))
  afterEach(() => act(resetStore))

  it('reports a rollback that does not sit just past the edited feature', async () => {
    usePartEditorStore.setState({ editingFeatureId: 'ex1', rollbackPosition: 0, pickBoundary: 0 })
    const current = await solveWithStore(DOC)
    expect(current.solveError).toMatch(/invariant.*rollback/)
  })

  it('reports a pick boundary that does not name the edited feature', async () => {
    usePartEditorStore.setState({ editingFeatureId: 'ex1', rollbackPosition: 1, pickBoundary: 5 })
    const current = await solveWithStore(DOC)
    expect(current.solveError).toMatch(/invariant.*pick_boundary/)
  })
})
