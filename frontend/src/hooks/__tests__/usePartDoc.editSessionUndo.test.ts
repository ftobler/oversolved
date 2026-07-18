import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc } from '@/types/cad'

// A live docRef the tests mutate to stand in for edits made during a session.
const docRef = { current: { features: [] } as unknown as PartDoc }
const pushUndo = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: null, setDoc: vi.fn(), docRef, docName: 'test', setDocName: vi.fn(),
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(), bodies: {}, pickBodies: {},
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve: vi.fn(), validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [], redoStack: [], suppressUndoRef: { current: false },
    pushUndo, handleUndo: vi.fn(), handleRedo: vi.fn(),
    saveUndoStackSnapshot: vi.fn(), restoreUndoStackSnapshot: vi.fn(),
    clearUndoStackSnapshot: vi.fn(),
  }),
}))

vi.mock('@/hooks/mutationDispatch', () => ({ mutationHandlers: {} }))

describe('commitEditSession undo entry', () => {
  beforeEach(() => {
    pushUndo.mockClear()
    docRef.current = { features: [] } as unknown as PartDoc
    usePartEditorStore.getState().setEditingFeatureId(null)
  })

  it('pushes no undo entry when the session changed nothing', () => {
    const { result } = renderHook(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    result.current.startEditSession(true)
    result.current.commitEditSession()
    expect(pushUndo).not.toHaveBeenCalled()
  })

  it('pushes one undo entry naming the edited feature when the doc changed', () => {
    const { result } = renderHook(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    result.current.startEditSession(true)
    docRef.current = { features: [{ id: 'extrude-1' }] } as unknown as PartDoc
    result.current.commitEditSession()

    expect(pushUndo).toHaveBeenCalledTimes(1)
    expect(pushUndo.mock.calls[0][0]).toEqual({ type: 'edit_session', featureId: 'extrude-1' })
    // The entry restores the pre-session doc, not the post-session one.
    expect(pushUndo.mock.calls[0][1]).toEqual({ features: [] })
  })
})
