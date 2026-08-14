import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { describeMutation } from '@/utils/core/mutationDescriptions'
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

const makeSketchDoc = (): PartDoc => ({
  oversolved: 1,
  kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch' }],
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

const sketchEntitiesOf = (): { id: string; kind: string }[] =>
  (docRef.current.features?.[0] as { entities: { id: string; kind: string }[] }).entities ?? []

const sketchConstraintsOf = (): { kind: string }[] =>
  (docRef.current.features?.[0] as { constraints?: { kind: string }[] }).constraints ?? []

describe('usePartDoc undo/redo integration', () => {
  beforeEach(() => {
    docRef.current = makeDoc()
    reSolve.mockClear()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    useSketchEditorStore.getState().resetTransientState()
    setSketchCallback('onMutation', null)
    setSketchCallback('onMutationBatch', null)
    setSketchCallback('beginBrepProjection', null)
    setSketchCallback('cancelBrepProjection', null)
    setSketchCallback('getSketch', null)
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
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const before = structuredClone(docRef.current)

    act(() => { result.current.startPreviewMode(before) })
    act(() => {
      result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' })
      result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' })
    })
    // Suppressed while previewing: intermediate frames are not undo steps.
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' }) })
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.part_style?.b1 as { color?: string }).color).toBe('#ff0000')

    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('a cancelled preview leaves no undo step and re-enables pushing', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.cancelPreview() })
    expect(result.current.undoStack).toHaveLength(0)

    // suppressUndoRef must have been cleared, or every later edit is lost.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' }) })
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('cancelPreview returns the exact pre-preview doc the caller restores from', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    const prePreview = structuredClone(docRef.current)
    act(() => { result.current.startPreviewMode(prePreview) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    let returned: PartDoc | null = null
    act(() => { returned = result.current.cancelPreview() })

    // The caller restores the doc from the return value, so it must be the
    // pre-preview snapshot, never the preview-mutated doc.
    expect(returned).toEqual(prePreview)
    expect(JSON.stringify(returned)).not.toBe(JSON.stringify(docRef.current))
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

  // Redo shares applyUndoRedo with undo, so the teardown the undo test above
  // pins is only half covered: a redo must tear the session down just the same,
  // or the swallow it left standing would eat every later edit with no undo step.
  it('redo exits any open edit and clears its suppression', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    usePartEditorStore.getState().setPickBoundary(1)
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    expect(result.current.undoStack).toHaveLength(0)  // swallowed by the session

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('a')
    expect(result.current.undoStack).toHaveLength(1)  // the redo counterpart
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()

    // The redo left suppression off: this edit pushes instead of vanishing.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(2)
    expect(labelOf()).toBe('after')
  })

  it('a mutation after undoing mid-preview is still one undo step', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.handleMutation(renameTo('after')) })

    // Exactly one entry: the abandoned preview must not leave a dead step of
    // its own behind, and the new edit must not be swallowed.
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.features?.[0] as { label?: string }).label).toBe('first')
  })

  it('a redo after undoing mid-preview returns to the doc the preview had mutated', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')

    // The teardown dropped the preview, so redo must land on the doc the
    // preview had mutated, not on a stale snapshot the session re-applied.
    act(() => { result.current.handleRedo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
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
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.discardSessions() })

    act(() => { result.current.handleMutation(renameTo('after')) })
    // The pre-existing entry survives (stacks untouched) and the new edit is
    // undoable again (suppression cleared). The pushed entry stores the doc
    // before the edit, which is the suppressed preview frame.
    expect(result.current.undoStack).toHaveLength(2)
    expect(labelOf()).toBe('after')
  })

  it('a sketch session leaves one entry per action and no aggregate edit_session', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })  // sketch: not suppressed
    act(() => {
      result.current.handleMutation(renameTo('a'))
      result.current.handleMutation(renameTo('b'))
      result.current.handleMutation(renameTo('c'))
    })
    act(() => { result.current.commitEditSession() })

    // Per-action entries are the undo story for a sketch session: N actions
    // leave N entries and the aggregate is not pushed on top.
    expect(result.current.undoStack).toHaveLength(3)
    expect(result.current.undoStack.every(e => e.mutation.type !== 'edit_session')).toBe(true)

    // N undos return to the pre-session state cleanly.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('b')
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('a')
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  // Every cancel test runs a suppressed session against an empty redo branch.
  // A sketch session is not suppressed: each action pushes its own entry and
  // each push clears the redo branch, so a cancel must restore the PARKED
  // pre-session stacks - including the redo branch the pushes invalidated.
  it('cancelling a sketch session with per-action entries restores both stacks and resurrects the pre-session redo', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    // Build a redo branch: undo a mutation so the pre-session redo has content.
    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)
    expect(labelOf()).toBe('first')

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(false) })  // sketch: not suppressed
    act(() => {
      result.current.handleMutation(renameTo('b'))
      result.current.handleMutation(renameTo('c'))
    })
    // Per-action entries; each push clears the redo branch it saw at start.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.redoStack).toHaveLength(0)

    act(() => { result.current.cancelEditSession() })

    // The in-session entries are dropped and the parked snapshot is restored:
    // undo goes back to empty and the pre-session redo branch comes back.
    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)

    // The resurrected branch still works: redo returns to the 'a' doc.
    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('a')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('a suppressed feature session folds N actions into exactly one entry', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => {
      result.current.handleMutation(renameTo('a'))
      result.current.handleMutation(renameTo('b'))
    })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
  })

  it('a no-op rename pushes nothing and neither dirties nor re-solves', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    act(() => { result.current.handleMutation(renameTo('first')) })  // already the label

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
    expect(labelOf()).toBe('first')
  })

  it('a no-op reorder pushes nothing and neither dirties nor re-solves', () => {
    // Four built-ins (Origin + three planes) precede the user feature; dropping
    // the feature on its own index maps to the clamped built-in boundary, which
    // the reorder handler treats as a no-op.
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane' },
        { id: 'Front', kind: 'plane' },
        { id: 'Right', kind: 'plane' },
        { id: 'f2', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'f2', toIndex: 4 }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('a same-color mutation pushes nothing and neither dirties nor re-solves', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('applying a preview that changed nothing leaves no undo step', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a no-change color Apply pushes nothing and does not set dirty', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    // Opening the popover and applying without touching anything commits a doc
    // identical to the pre-preview doc: no step, and the doc is not dirtied.
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a preview that changed multiple material fields commits with a composite label', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => {
      result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 })
      result.current.handleMutation({ type: 'set_part_metalness', bodyId: 'b1', metalness: 0.8 })
    })
    // The popover applies set_part_color no matter what was actually edited, so
    // the committed label must come from the doc diff, not that mutation.
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(1)
    const label = describeMutation(result.current.undoStack[0].mutation)
    expect(label).toContain('transparency')
    expect(label).toContain('metalness')
    expect(label).not.toContain('color')
  })

  it('a sketch edit mid-preview escapes: color folds into preview_commit, the edit keeps its own entry, and cancel does not rewind', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    // A line drawn while the popover is open is not a preview-scope mutation,
    // so it escapes: the pending color folds into a preview_commit entry and
    // the line pushes its own entry after it.
    act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l1' } as Mutation) })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect(result.current.undoStack[1].mutation.type).toBe('add_entity')
    expect(sketchEntitiesOf().some(e => e.id === 'l1')).toBe(true)

    // The preview already committed via the escape, so Cancel has nothing to
    // rewind: the line must survive.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect(sketchEntitiesOf().some(e => e.id === 'l1')).toBe(true)
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')
  })

  it('a pure preview swallows slider moves, Apply pushes one preview_commit, and Cancel rewinds', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000', transparency: 0 } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const prePreview = structuredClone(docRef.current)

    // Apply path: slider moves are swallowed, exactly one preview_commit.
    act(() => { result.current.startPreviewMode(prePreview) })
    act(() => {
      result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 })
      result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.7 })
    })
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect((result.current.undoStack[0].doc.part_style?.b1 as { transparency?: number }).transparency).toBe(0)
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0.7)

    // Cancel path: the preview is rewound to the pre-preview doc, no new entry.
    act(() => { result.current.startPreviewMode(prePreview) })
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.9 }) })
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toEqual(prePreview)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('a preview inside a suppressed feature session keeps suppression on and commits beside the aggregate', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('session-edit')) })
    expect(result.current.undoStack).toHaveLength(0)

    // A color preview opened and applied mid-session.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    // Apply must NOT have reset suppression: the session is still the undo
    // owner, so a later session edit stays swallowed.
    act(() => { result.current.handleMutation(renameTo('still-swallowed')) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')

    act(() => { result.current.commitEditSession() })
    // The session aggregate lands on top of the preview_commit: two real
    // steps, and the session's own edits were never double-recorded.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[1].mutation.type).toBe('edit_session')
  })

  // The only ordering the tests above cover is Apply-before-commit (the
  // popover resolves itself, then the session closes). The other ordering --
  // the session commits FIRST, with the popover still open and never Applied
  // -- used to leave previewOriginalDoc pointing at a doc the session had
  // already moved past, so a later Cancel rewound to it and desynced the live
  // doc from the undo stack (undo-preview-session-exit.md repro).
  it('a preview left open when the session commits is resolved at the boundary, not orphaned', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000', transparency: 0 } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    // A real, non-style session edit lands while the popover is open. It is
    // not a preview-scope mutation, but the session's own 'all' scope still
    // swallows it whole (the escape gate requires the session itself to not
    // be active), so it earns no entry of its own here either.
    act(() => { result.current.handleMutation(renameTo('mid-session')) })
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 }) })
    expect(result.current.undoStack).toHaveLength(0)

    // OK on the feature edit fires with the color popover still open (no
    // Apply was ever clicked): the session boundary must resolve the preview
    // itself, landing preview_commit under the session's own aggregate.
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect(result.current.undoStack[1].mutation.type).toBe('edit_session')
    const afterCommit = structuredClone(docRef.current)

    // The popover is still visually open; dragging it again is now a plain
    // live edit (no preview is tracking it anymore), pushed as its own entry.
    act(() => { result.current.handleMutation({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.9 }) })
    expect(result.current.undoStack).toHaveLength(3)

    // Cancel finds no active preview -- it was already resolved at the
    // session boundary -- so it must not silently rewind to some other, stale
    // doc. That desync (live doc pointing past what the stack's top entry
    // expects) is exactly what let a cancelled colour resurrect on undo.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0.9)

    // Undo walks back cleanly through all three real entries; the swallowed
    // 0.5 frame never resurfaces as an out-of-band state.
    act(() => { result.current.handleUndo() })
    expect(docRef.current).toEqual(afterCommit)
    act(() => { result.current.handleUndo() })
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect((docRef.current.part_style?.b1 as { transparency?: number }).transparency).toBe(0)
  })

  it('a preview left open when the session commits collapses to the single preview_commit when nothing else in the session changed', () => {
    // Closes the previously-documented gap at the "part_style-only" test
    // below (undoIntegration.test.ts:790-808 pre-fix): that test never opens
    // a preview, so a bare set_part_color mutation is swallowed with no
    // resolver at all. Here a preview WAS opened, so the session boundary
    // must resolve it into exactly one preview_commit, not an empty
    // edit_session (part_style is excluded from the aggregate's own diff).
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    // The popover's own Cancel afterward finds nothing left to resolve.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a preview opened but never touched leaves nothing behind when the session commits', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a non-preview edit swallowed while the popover stays open is discarded cleanly by session cancel', () => {
    // The cancel-leg repro: a feature-field edit landing inside a suppressed
    // session while the popover is open used to be swallowed with no entry
    // (the escape gate required the session itself to not be active), and a
    // later Cancel rewinding past the session snapshot dropped it silently.
    // Confirms it is discarded together with the whole session, no dead entry
    // left behind either way.
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })

    act(() => { result.current.handleMutation(renameTo('mid-popover')) })
    expect(labelOf()).toBe('mid-popover')
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // previewOriginalDoc was dropped WITH the session rather than rewound
    // through, so the popover's own Cancel afterward is an inert no-op instead
    // of a second, stale rewind.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('a nested startPreviewMode fails loud and leaves the first preview baseline intact', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const baseline = structuredClone(docRef.current)

    act(() => { result.current.startPreviewMode(baseline) })
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/nested preview/)

    // The nested call returned before touching the baseline: a slider move
    // still swallows and the commit restores the FIRST preview's pre-preview
    // doc, proving the baseline was not overwritten.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('a solve-fabricated part_style entry does not manufacture a phantom preview_commit', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    // No slider was touched. A solve reconciles part_style and fabricates an
    // entry for a body that had none; nothing else changed.
    docRef.current.part_style = { ...(docRef.current.part_style ?? {}), b2: { name: 'part 2', color: '#00ff00' } }
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('an end-snapped line mid-preview escapes: color folds into preview_commit and the group keeps its own entry', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    // A snapped line routes through commitMutationGroup while the popover is
    // open; it is not a preview-scope mutation, so it escapes the same way a
    // single sketch edit does.
    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2' },
        { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l2:start', 'entity:sk1:l1'] },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
    expect(result.current.undoStack[1].mutation.type).toBe('add_entity')
    expect(sketchEntitiesOf().some(e => e.id === 'l2')).toBe(true)
    expect(sketchConstraintsOf()).toHaveLength(1)
  })

  it('an end-snapped line committed as a group is one undo step restoring both', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2' },
        { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l2:start', 'entity:sk1:l1'] },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(sketchEntitiesOf().some(e => e.id === 'l2')).toBe(true)
    expect(sketchConstraintsOf()).toHaveLength(1)

    act(() => { result.current.handleUndo() })

    // One undo removes the line and its end constraint together.
    expect(sketchEntitiesOf().some(e => e.id === 'l2')).toBe(false)
    expect(sketchConstraintsOf()).toHaveLength(0)
  })

  it('projecting N faces is one undo step', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId: 'p1' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:2', entityId: 'p2' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:3', entityId: 'p3' },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(sketchEntitiesOf()).toHaveLength(3)

    act(() => { result.current.handleUndo() })

    expect(sketchEntitiesOf()).toHaveLength(0)
  })

  it('deleting N selected features is one undo step', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [
        { id: 'f1', kind: 'sketch' },
        { id: 'f2', kind: 'extrude' },
        { id: 'f3', kind: 'fillet' },
        { id: 'f4', kind: 'chamfer' },
      ],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => {
      result.current.commitMutationGroup([
        { type: 'delete_feature', featureId: 'f2' },
        { type: 'delete_feature', featureId: 'f3' },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect((docRef.current.features ?? []).map((f: { id: string }) => f.id)).toEqual(['f1', 'f4'])

    act(() => { result.current.handleUndo() })

    expect((docRef.current.features ?? []).map((f: { id: string }) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4'])
  })

  it('a suppressed session whose only change is part_style leaves no aggregate entry', () => {
    // part_style is excluded from the session diff because the solver
    // fabricates it during a solve; a session whose only real difference is
    // part_style must not manufacture an undo entry either.
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('no-op visibility and suppression toggles push nothing and neither dirty nor re-solve', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [{ id: 'f1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    // Showing a feature that already has no visible override changes nothing.
    act(() => { result.current.handleMutation({ type: 'set_feature_visibility', featureId: 'f1', visible: true }) })
    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()

    // Unsuppressing a feature that is not suppressed changes nothing.
    act(() => { result.current.handleMutation({ type: 'set_feature_suppression', featureId: 'f1', suppressed: false }) })
    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('add_fillet_edge is a toggle, so re-adding a listed edge is a real change', () => {
    docRef.current = {
      oversolved: 1,
      kind: 'part',
      features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?edge1'] } }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?edge1' }) })

    // The second add REMOVES the edge (toggle), a genuine change, so it pushes.
    expect(result.current.undoStack).toHaveLength(1)
    const fillet = (docRef.current.features?.[0] as { fillet: { edges: string[] } }).fillet
    expect(fillet.edges).toEqual([])
  })

  it('a two-pick brep dimension is one undo step that drops both projections', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      act(() => { store.addBrepDimensionPick('?b1/edge:2', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(2)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })

      expect(result.current.undoStack).toHaveLength(1)
      expect(sketchConstraintsOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })

      // One undo removes the dimension and BOTH projections: the second pick
      // must not have replaced the pre-gesture doc the commit restores.
      expect(sketchEntitiesOf()).toHaveLength(0)
      expect(sketchConstraintsOf()).toHaveLength(0)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('an unrelated mutation mid-gesture clears the brep withhold and owns the projection', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A tree edit lands between the pick and the commit. It pushes its own
      // entry restoring the CURRENT doc (which carries the projection) and
      // clears the withhold, so the projection is owned by a normal entry chain
      // instead of waiting on a pre-pick doc a later commit cannot see.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect((result.current.undoStack[0].doc.features?.[0] as { entities: unknown[] }).entities).toHaveLength(1)

      // The commit keys to the current doc: its entry restores the projection
      // and the steal, so undo removes only the dimension.
      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect((result.current.undoStack[1].doc.features?.[0] as { entities?: unknown[] }).entities ?? []).toHaveLength(2)

      act(() => { result.current.handleUndo() })

      // The dimension is gone, the projection and the mid-gesture edit survive.
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(2)

      act(() => { result.current.handleUndo() })

      // The steal reverts and the projection survives owned: no step can
      // re-materialise it alone off a removed pre-pick key.
      expect(sketchEntitiesOf()).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a non-dimension add_constraint mid-gesture clears the withhold instead of consuming it', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A geometric add_constraint (coincident) lands between the pick and the
      // commit. It is NOT the brep dimension commit, so it must push its own
      // entry restoring the CURRENT doc (projection included) and clear the
      // withhold, exactly like any other steal. Consuming the withhold here
      // would key an entry to a pre-pick doc the projection can never be
      // restored from.
      act(() => { result.current.handleMutation({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l1:end', 'vertex:sk1:l2:start'] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect((result.current.undoStack[0].doc.features?.[0] as { entities: unknown[] }).entities).toHaveLength(1)

      // The dimension commit now keys to the current doc: undo removes only the
      // dimension, leaving the projection and the geometric constraint.
      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect(sketchConstraintsOf().map(c => c.kind).sort()).toEqual(['coincident', 'length'])
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf().map(c => c.kind)).toEqual(['coincident'])
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a rename-steal mid-gesture undoes per step and never strands the projection', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      // A tree rename steals the gesture mid-flight. It pushes its own entry
      // and clears the withhold, so the commit keys to the current doc instead
      // of a pre-pick doc the steal's own undo has moved past.
      act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'sk1', label: 'renamed' } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect(labelOf()).toBe('renamed')

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect(sketchConstraintsOf()).toHaveLength(1)

      // One undo removes only the dimension: the projection and the rename
      // survive, each owned by their own entry.
      act(() => { result.current.handleUndo() })
      expect(sketchConstraintsOf()).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
      expect(labelOf()).toBe('renamed')

      // A second undo reverts the rename and keeps the projection as a normal
      // entity: it never re-materialises alone off a removed pre-pick key.
      act(() => { result.current.handleUndo() })
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)
      expect(labelOf()).toBeUndefined()
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a brep dimension pick and its OK commit are one undo step', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' }) })

      // The projection is committed to the doc but not to the stack: its entry
      // waits for the dimension commit.
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(1)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })

      expect(result.current.undoStack).toHaveLength(1)
      expect(sketchConstraintsOf()).toHaveLength(1)

      act(() => { result.current.handleUndo() })

      // One undo removes the dimension and the projection together.
      expect(sketchEntitiesOf()).toHaveLength(0)
      expect(sketchConstraintsOf()).toHaveLength(0)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('cancelling a brep dimension pick removes the projection and its entry', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      act(() => { store.addBrepDimensionPick('?b1/edge:3', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)

      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onCancel!() })

      // The projection is gone and nothing was pushed: no orphan, no stale step.
      expect(result.current.undoStack).toHaveLength(0)
      expect(sketchEntitiesOf()).toHaveLength(0)

      // The withhold was cleared, so a later edit pushes normally again.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
    } finally {
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
      useSketchEditorStore.getState().resetTransientState()
    }
  })

  it('a projection group run while a brep withhold is pending restores the pre-pick doc in one entry', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))

    // A pick armed the withhold; the N-face projection lands through the
    // gesture-group seam instead of the single-mutation funnel. The group must
    // honor the withhold the same way handleMutation does.
    act(() => { result.current.beginBrepProjection() })
    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId: 'p1' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:2', entityId: 'p2' },
        { type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:3', entityId: 'p3' },
      ] as Mutation[])
    })

    // The group consumed the arm: no entry yet, the projections wait for the
    // dimension commit like any withheld projection.
    expect(result.current.undoStack).toHaveLength(0)
    expect(sketchEntitiesOf()).toHaveLength(3)

    act(() => {
      result.current.handleMutation({
        type: 'add_constraint', featureId: 'sk1', kind: 'length',
        targets: ['entity:sk1:p1'], value: 10,
      } as Mutation)
    })

    // One entry keyed to the pre-pick doc: undo removes the dimension and all
    // three projections together, nothing is orphaned.
    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].doc.features?.[0] as { entities?: unknown[] }).entities ?? []).toHaveLength(0)

    act(() => { result.current.handleUndo() })
    expect(sketchEntitiesOf()).toHaveLength(0)
    expect(sketchConstraintsOf()).toHaveLength(0)
  })

  it('a brep arm made while suppression is on does not leak past the suppression boundary', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', 'code', vi.fn(), { solveOnLoad: false }))
    usePartEditorStore.getState().setEditingFeatureId('sk1')

    // A suppressed feature session is the undo owner; a brep pick armed inside
    // it has its projection swallowed without an entry.
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.beginBrepProjection() })
    act(() => {
      result.current.handleMutation({ type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId: 'p1' } as Mutation)
    })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitEditSession() })
    // The session folds into one aggregate and suppression turns off.
    expect(result.current.undoStack).toHaveLength(1)

    // Without the swallow consuming the arm, this unrelated edit would still
    // be swallowed as "the projection" and never earn an entry.
    act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
    expect(result.current.undoStack).toHaveLength(2)
  })
})
