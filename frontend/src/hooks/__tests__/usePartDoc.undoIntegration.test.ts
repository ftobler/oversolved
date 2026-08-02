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
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleUndo() })

    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    // The session suppressed undo pushes; if the undo left that suppression
    // standing, every later edit would silently drop out of the stack with no
    // way for the user to notice or recover.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('a mutation after undoing mid-preview is still one undo step', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(renameTo('previewed')) })

    act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.handleMutation(renameTo('after')) })

    // Exactly one entry: the abandoned preview must not leave a dead step of
    // its own behind, and the new edit must not be swallowed.
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.features?.[0] as { label?: string }).label).toBe('first')
  })

  it('committing an edit session orphaned by an undo pushes nothing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')

    // The OK button of the edit the undo already closed. The session is gone,
    // so this must be inert instead of pushing a step keyed to the pre-undo doc.
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
    expect(labelOf()).toBe('first')
  })

  // Redo shares applyUndoRedo with undo, so this exists to keep the teardown out
  // of an undo-only branch if that function is ever split.
  it('committing an edit session orphaned by a redo pushes nothing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('a')

    act(() => { result.current.commitEditSession() })

    // Only the counterpart entry the redo itself left behind.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
    expect(labelOf()).toBe('a')
  })

  it('cancelling an edit session orphaned by an undo does not revert the undo', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')

    act(() => { result.current.cancelEditSession() })

    // Restoring the session snapshot here would jump the doc back to 'a' and
    // re-commit the pre-undo stacks, silently undoing the undo.
    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
  })

  it('undo restores the rollback position the doc was saved with', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setRollbackPosition(0)

    act(() => { result.current.handleUndo() })

    // The restored doc parks the bar at the end of its own feature list.
    expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
  })

  it('discardSessions re-enables undo pushes without clearing the stacks', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('kept')) })
    expect(result.current.undoStack).toHaveLength(1)

    // A preview started while the code tab is open sets suppressUndoRef, which
    // the code-tab exit must clear or every later tree edit is silently lost.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(renameTo('suppressed')) })
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.discardSessions() })

    act(() => { result.current.handleMutation(renameTo('after')) })
    // The pre-existing entry survives (stacks untouched) and the new edit is
    // undoable again (suppression cleared). The pushed entry stores the doc
    // before the edit, which is the suppressed preview frame.
    expect(result.current.undoStack).toHaveLength(2)
    expect(labelOf()).toBe('after')
  })
})
