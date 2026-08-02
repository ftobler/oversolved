import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
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

  it('an unrelated mutation mid-gesture does not consume the brep withhold', () => {
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

      // A tree edit lands between the pick and the commit. It must push its own
      // entry restoring the CURRENT doc (which carries the projection), not the
      // pre-pick doc the withhold captured.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      expect(result.current.undoStack).toHaveLength(1)
      expect((result.current.undoStack[0].doc.features?.[0] as { entities: unknown[] }).entities).toHaveLength(1)

      // The withhold survives for the commit: OK still restores the pre-gesture
      // doc, so the projection is not left stranded.
      act(() => { store.finalizeDimensionPlacement([0, 0]) })
      const dialog = useSketchEditorStore.getState().pendingDialog!
      act(() => { dialog.onConfirm('10') })
      expect(result.current.undoStack).toHaveLength(2)
      expect((result.current.undoStack[1].doc.features?.[0] as { entities?: unknown[] }).entities ?? []).toHaveLength(0)
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
})
