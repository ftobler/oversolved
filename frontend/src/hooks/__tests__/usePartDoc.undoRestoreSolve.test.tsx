/**
 * Undo of a delete re-solves through the REAL solver for the retained-snapshot
 * fix.
 *
 * The regression this pins: the undo entry stores no solve results (they are
 * not doc content), so the undo re-solve has nothing to fall back on when it
 * fails. A deleted BREP/import feature then renders blank forever. usePartDoc
 * now retains the pruned snapshot (the stash) and the reSolve handed to
 * useUndoRedo hands it back as _restoreSolveResults, so a failing undo re-solve
 * re-renders the feature via restorePrunedResults.
 *
 * The harness drives usePartDoc + useUndoRedo with the REAL useSolver and the
 * worker mocked, exactly like usePartDoc.solverWriteback.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))
vi.mock('@/stores/solverStore', () => ({
  useSolverStore: { getState: () => ({ setIsSolving: vi.fn(), setOnCancelSolve: vi.fn(), onCancelSolve: null }) },
}))

const docRef: { current: PartDoc | null } = { current: null }
const saveDocMock = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: (d: PartDoc) => { docRef.current = d },
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    ownerUsername: null,
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: saveDocMock,
    renameDoc: vi.fn(),
    cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

// A worker that reports a solve for every feature the payload carries, exactly
// like the real kernel: a deleted feature has no record after the delete's
// re-solve, and is repopulated by the undo's.
function okImpl(payload: Record<string, unknown>) {
  const features = (payload.features as { id: string }[]) ?? []
  const result: Record<string, unknown> = {}
  for (const f of features) result[f.id] = { status: 'ok' }
  return Promise.resolve({ solve_ms: 0, result, bodies: {}, _build_state: null })
}

const importDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'imp1', kind: 'import_step', label: 'part', file_data: 'STEP' }],
} as unknown as PartDoc)

const extrudeDoc = (...ids: string[]): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: ids.map((id, i) => ({ id, kind: 'extrude', label: `ext ${i}` })),
} as unknown as PartDoc)

const sketchDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial: {} }],
} as unknown as PartDoc)

const renameTo = (featureId: string, label: string): Mutation =>
  ({ type: 'rename_feature', featureId, label }) as Mutation

describe('undo restore of pruned solve results', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveDocMock.mockReset()
    useUnsavedChangesStore.getState().setDirty(false)
    const store = usePartEditorStore.getState()
    store.setEditingFeatureId(DEFAULT_PART_EDITOR_DATA.editingFeatureId)
    store.setPickBoundary(DEFAULT_PART_EDITOR_DATA.pickBoundary)
    store.setRollbackPosition(DEFAULT_PART_EDITOR_DATA.rollbackPosition)
  })

  // The reSolve fire-and-forgets; drain the microtask queue so the solve (mock
  // worker) lands before the next assertion.
  const flush = async () => { await act(async () => {}) }

  it('a failing undo re-solve re-renders the deleted BREP feature from the retained snapshot', async () => {
    docRef.current = importDoc()
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // Any real edit drives a solve, which gives the feature a solve result to
    // prune later.
    act(() => { result.current.handleMutation(renameTo('imp1', 'edited')) })
    await flush()
    expect(result.current.solveResults.imp1).toBeDefined()

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'imp1' } as Mutation) })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'imp1')).toBe(false)
    expect(result.current.solveResults.imp1).toBeUndefined()

    // The undo re-solve fails (local solver unavailable). Without the retained
    // snapshot the restored feature would be blank forever.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleUndo() })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'imp1')).toBe(true)
    expect(result.current.solveResults.imp1).toBeDefined()
    expect(result.current.solveError).toContain('Local solver unavailable')
  })

  it('a successful undo re-solve renders the deleted BREP feature immediately', async () => {
    docRef.current = importDoc()
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('imp1', 'edited')) })
    await flush()
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'imp1' } as Mutation) })
    await flush()
    expect(result.current.solveResults.imp1).toBeUndefined()

    act(() => { result.current.handleUndo() })
    await flush()
    // The feature is back in the doc and its record is present, not blank.
    expect(docRef.current!.features!.some(f => f.id === 'imp1')).toBe(true)
    expect(result.current.solveResults.imp1).toBeDefined()
    expect(result.current.solveError).toBeNull()
  })

  it('a stale stash entry is never restored for a feature the entry doc lacks', async () => {
    docRef.current = extrudeDoc('ex1', 'ex2', 'ex3')
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('ex1', 'edited')) })
    await flush()
    expect(result.current.solveResults.ex1).toBeDefined()
    expect(result.current.solveResults.ex2).toBeDefined()
    expect(result.current.solveResults.ex3).toBeDefined()

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex2' } as Mutation) })
    await flush()
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex3' } as Mutation) })
    await flush()
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['ex1'])

    // The undo restores the pre-delete doc [ex1, ex3]; the retained ex2 entry
    // must not be read for a doc that no longer contains ex2.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleUndo() })
    await flush()
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['ex1', 'ex3'])
    expect(result.current.solveResults.ex3).toBeDefined()
    expect(result.current.solveResults.ex2).toBeUndefined()
  })

  it('a successful solve consumes the stash entry (a later failing undo does not resurrect it)', async () => {
    docRef.current = extrudeDoc('ex1')
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('ex1', 'edited')) })
    await flush()
    expect(result.current.solveResults.ex1).toBeDefined()

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex1' } as Mutation) })
    await flush()
    act(() => { result.current.handleUndo() })
    await flush()
    // The undo solve succeeded: the fresh result supersedes the retained
    // snapshot and clears the stash (useSolver's onSolveApplied).
    expect(docRef.current!.features!.some(f => f.id === 'ex1')).toBe(true)
    expect(result.current.solveResults.ex1).toBeDefined()

    // Redo re-deletes; the redo re-solve has no ex1 in its payload, so the
    // record is replaced without it. The consumed snapshot is gone, so a later
    // failing undo cannot resurrect the pre-solve geometry - the plan's
    // accepted transient blank once the fresh result has superseded the stash.
    act(() => { result.current.handleRedo() })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'ex1')).toBe(false)
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleUndo() })
    await flush()
    expect(result.current.solveResults.ex1).toBeUndefined()
  })

  it('a failing forward delete does not consume the stash, so a later failing undo still restores', async () => {
    docRef.current = extrudeDoc('ex1', 'ex2')
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('ex1', 'edited')) })
    await flush()
    expect(result.current.solveResults.ex1).toBeDefined()

    // The delete's own re-solve fails: restorePrunedResults lands the snapshot
    // in solveResults, but no solve SUCCEEDED, so the stash must survive for
    // the undo that follows.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'ex1' } as Mutation) })
    await flush()
    expect(result.current.solveResults.ex1).toBeDefined()

    // A later successful solve (of ex2) replaces the record without ex1; the
    // stash entry for ex1 must still be there when the undo re-solve fails.
    mockSolveViaWorker.mockImplementation(okImpl)
    act(() => { result.current.handleMutation(renameTo('ex2', 'edited')) })
    await flush()
    expect(result.current.solveResults.ex1).toBeUndefined()

    mockSolveViaWorker.mockResolvedValue(null)
    // Undo the rename first (restores [ex2]), then the delete: the delete's
    // entry restores the pre-delete doc [ex1, ex2], whose re-solve fails.
    act(() => { result.current.handleUndo() })
    await flush()
    act(() => { result.current.handleUndo() })
    await flush()
    // The retained ex1 snapshot re-renders it despite the failing re-solve.
    expect(docRef.current!.features!.some(f => f.id === 'ex1')).toBe(true)
    expect(result.current.solveResults.ex1).toBeDefined()
  })

  it('the stash is scoped to body-producing kinds: a sketch is not retained', async () => {
    docRef.current = sketchDoc()
    mockSolveViaWorker.mockImplementation(okImpl)

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('sk1', 'edited')) })
    await flush()
    expect(result.current.solveResults.sk1).toBeDefined()

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })
    await flush()
    expect(result.current.solveResults.sk1).toBeUndefined()

    // The failing undo re-solve has no snapshot to restore for a sketch (it
    // renders from its doc `initial`), which is the accepted scoped behavior.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleUndo() })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'sk1')).toBe(true)
    expect(result.current.solveResults.sk1).toBeUndefined()
  })
})
