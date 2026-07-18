import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

// Exercises usePartDoc against the REAL useUndoRedo and the REAL mutation
// handlers. The other usePartDoc undo tests mock the stack out, so they only
// prove which calls were made -- never that an edit session, a preview and the
// stack actually compose. This is the flow a user walks.

const makeDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

const docRef = { current: makeDoc() }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
    permission: 'owner', isCloudDoc: false,
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(), bodies: {}, pickBodies: {},
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve, validation: null,
  }),
}))

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label }) as Mutation

const labelOf = () => (docRef.current.features?.[0] as { label?: string }).label

describe('usePartDoc undo/redo integration', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
  })

  it('a plain mutation is undone and redone as one step', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('second')) })
    expect(labelOf()).toBe('second')
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('second')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('an edit session collapses its mutations into one undo step', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => {
      result.current.handleMutation(renameTo('a'))
      result.current.handleMutation(renameTo('b'))
      result.current.handleMutation(renameTo('c'))
    })
    act(() => { result.current.commitEditSession() })

    // Three mutations, one entry -- the session is the undo granularity.
    expect(result.current.undoStack).toHaveLength(1)
    expect(labelOf()).toBe('c')

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')  // all the way back past every in-session edit
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('c')
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('an edit session that changed nothing leaves no undo step', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a cancelled edit session restores the doc and leaves the stack untouched', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('kept')) })
    expect(result.current.undoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('kept')
    // The pre-session snapshot is restored, so the cancelled work is not an
    // undo step and the earlier mutation is still the top of the stack.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  it('a committed preview is one undo step back to the pre-preview doc', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const before = structuredClone(docRef.current)

    act(() => { result.current.startPreviewMode(before) })
    act(() => {
      result.current.handleMutation(renameTo('drag-1'))
      result.current.handleMutation(renameTo('drag-2'))
    })
    // Suppressed while previewing: intermediate frames are not undo steps.
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitPreview(renameTo('drag-2')) })
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  it('a cancelled preview leaves no undo step and re-enables pushing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(renameTo('drag-1')) })
    act(() => { result.current.cancelPreview() })
    expect(result.current.undoStack).toHaveLength(0)

    // suppressUndoRef must have been cleared, or every later edit is lost.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('a new mutation after an undo discards the redo branch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.handleMutation(renameTo('b')) })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('undo exits any open edit and marks the doc unsaved', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    usePartEditorStore.getState().setPickBoundary(1)
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleUndo() })

    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('undo restores the rollback position the doc was saved with', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setRollbackPosition(0)

    act(() => { result.current.handleUndo() })

    // The restored doc parks the bar at the end of its own feature list.
    expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
  })
})
