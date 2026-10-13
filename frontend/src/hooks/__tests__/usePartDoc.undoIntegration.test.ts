import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import type { PartDoc, Mutation } from '@/types/cad'
import {
  docRef, reSolve, makeSketchDoc, renameTo, labelOf,
  sketchEntitiesOf, sketchConstraintsOf, resetHarness,
} from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

describe('usePartDoc undo/redo integration', () => {
  beforeEach(resetHarness)

  it('a plain mutation is undone and redone as one step', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a cancelled edit session restores the doc and leaves the stack untouched', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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

  // The L8 contract the page's add+enter now uses: a session started BEFORE an
  // add suppresses the add, so Cancel rewinds it away and charges no entry.
  it('cancelEditSession rewinds an add dispatched inside the session', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation({ type: 'add_sketch', featureId: 'sk-new', label: 'sketch 2' }) })
    expect((docRef.current.features ?? []).some(f => f.id === 'sk-new')).toBe(true)
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelEditSession() })

    expect((docRef.current.features ?? []).some(f => f.id === 'sk-new')).toBe(false)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('a committed preview is one undo step back to the pre-preview doc', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
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
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    act(() => { result.current.cancelPreview() })
    expect(result.current.undoStack).toHaveLength(0)

    // suppressUndoRef must have been cleared, or every later edit is lost.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#0000ff' }) })
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('cancelPreview rewinds the live doc to the pre-preview doc and re-solves it', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    const prePreview = structuredClone(docRef.current)
    act(() => { result.current.startPreviewMode(prePreview) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    reSolve.mockClear()
    let returned: PartDoc | null = null
    act(() => { returned = result.current.cancelPreview() })

    // The hook owns the rewind: the live doc is the pre-preview snapshot, never
    // the preview-mutated doc, and the viewport is re-solved against it.
    expect(returned).toEqual(prePreview)
    expect(docRef.current).toBe(returned)
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect(reSolve).toHaveBeenCalledWith(returned)
  })

  it('a new mutation after an undo discards the redo branch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.handleMutation(renameTo('b')) })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('undo exits any open edit and marks the doc unsaved', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    // The undo committed the session as its own entry and reverted just that:
    // the rename before the session stays applied.
    expect(labelOf()).toBe('a')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack.map(e => e.mutation.type)).toEqual(['edit_session'])

    // The session suppressed undo pushes; if the undo left that suppression
    // standing, every later edit would silently drop out of the stack with no
    // way for the user to notice or recover.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(2)
  })

  // The bug this guards: with nothing below the session, the undo used to
  // return early and the session's edits could only be cancelled, never undone.
  it('undo mid-session on an empty stack reverts the session edits', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.handleUndo() })

    expect(labelOf()).toBe('first')
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('in-edit')
  })

  // A session that changed nothing is not committed: closing it would leave the
  // editor open with its session gone, and the empty-stack undo would never tear
  // the editor down. The session stays live and keeps suppressing.
  it('undo mid-session with no change on an empty stack leaves the session open', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleUndo() })

    expect(usePartEditorStore.getState().editingFeatureId).toBe('extrude-1')
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    expect(result.current.undoStack).toHaveLength(0)  // still swallowed
    act(() => { result.current.cancelEditSession() })
    expect(labelOf()).toBe('first')
  })

  // Redo now routes through the same open-work commit as undo: a redo mid-edit
  // commits the session as its own entry rather than tearing it down
  // uncommitted. Because that commit's push clears the redo branch, the redo
  // itself is a no-op afterwards -- the commit supersedes it -- but the
  // suppression the session held is gone, so later edits push normally.
  it('redo mid-session commits the session and re-enables pushing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    usePartEditorStore.getState().setPickBoundary(1)
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    expect(result.current.undoStack).toHaveLength(0)  // swallowed by the session

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('in-edit')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
    expect(result.current.redoStack).toHaveLength(0)

    // The commit cleared the redo branch, so the redo could not move and
    // applyUndoRedo never reached its own teardown. The handler had to run it:
    // the editor is closed, not left standing with the OK button inert.
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()

    // The redo left suppression off: this edit pushes instead of vanishing.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack).toHaveLength(2)
    expect(labelOf()).toBe('after')
  })

  // Mirrors the assembly engine's `redo mid-session commits the session and
  // clears the redo branch`: the redo commits the session first, that fresh
  // entry invalidates the redo branch like any edit, so the redo is a no-op and
  // the edits stay, reachable by the next undo back to the pre-session doc.
  it('redo mid-session commits the session and clears the redo branch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleRedo() })

    expect(labelOf()).toBe('in-edit')
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['edit_session'])
    expect(result.current.redoStack).toHaveLength(0)

    // The session's edits were committed, not dropped: one undo reaches the doc
    // the session started from.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  // Pins that the open-work commit inside a redo is the whole story: the redo
  // branch is consumed, the doc stays exactly the post-edit doc (no redo entry
  // is applied on top of it), and nothing is lost to the commit.
  it('redo with an open session leaves the doc at the post-edit state and the redo branch empty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    const postEdit = structuredClone(docRef.current)

    act(() => { result.current.handleRedo() })

    expect(docRef.current).toEqual(postEdit)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('a mutation after undoing mid-preview is still one undo step', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    // The undo commits the changed preview as its own entry and reverts only
    // the color; the rename before it stays applied.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('a')
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect(result.current.undoStack).toHaveLength(1)

    act(() => { result.current.handleMutation(renameTo('after')) })

    // One new entry: the closed preview must not leave a dead step of its own
    // behind, and the new edit must not be swallowed.
    expect(result.current.undoStack).toHaveLength(2)
    expect((result.current.undoStack[1].doc.features?.[0] as { label?: string }).label).toBe('a')
  })

  it('a redo after undoing mid-preview returns to the doc the preview had mutated', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
    expect(labelOf()).toBe('a')

    // The undo closed the preview, so redo must land on the doc the preview
    // had mutated, not on a stale snapshot the session re-applied.
    act(() => { result.current.handleRedo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.redoStack).toHaveLength(0)
  })

  // The preview arm of the same commit rule: a redo with a live preview commits
  // the preview as its own entry, which clears the redo branch, so the redo
  // itself is a no-op and the previewed doc stays reachable by undo.
  it('redo mid-preview commits the preview and clears the redo branch', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    act(() => { result.current.handleRedo() })

    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['preview_commit'])
    expect(result.current.redoStack).toHaveLength(0)

    // The commit closed the preview before the no-op redo, so the popover has
    // nothing left to cancel and the doc is not rewound a second time.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')

    act(() => { result.current.handleUndo() })
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#ff0000')
  })

  it('committing an edit session orphaned by an undo pushes nothing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('a')

    // The OK button of the edit the undo already closed. The session is gone,
    // so this must be inert instead of pushing a step keyed to the pre-undo doc.
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(labelOf()).toBe('a')
  })

  // Redo now commits the open session itself, so the editor's later OK has
  // nothing left to commit: the redo already banked the step and consumed the
  // redo branch, and the second commit must be inert.
  it('committing an edit session the redo already committed pushes nothing', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleRedo() })
    expect(labelOf()).toBe('in-edit')

    act(() => { result.current.commitEditSession() })

    // The session was already committed by the redo; the second commit is a
    // no-op and neither stack nor doc moves.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
    expect(labelOf()).toBe('in-edit')
  })

  it('cancelling an edit session orphaned by an undo does not revert the undo', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('a')

    act(() => { result.current.cancelEditSession() })

    // Restoring the session snapshot here would re-commit the pre-undo stacks
    // and drop the redo entry the undo just made, silently undoing the undo.
    expect(labelOf()).toBe('a')
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(1)
  })

  it('undo restores the rollback position the doc was saved with', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    usePartEditorStore.getState().setRollbackPosition(0)

    act(() => { result.current.handleUndo() })

    // The restored doc parks the bar at the end of its own feature list.
    expect(usePartEditorStore.getState().rollbackPosition).toBe(1)
  })

  it('a sketch session leaves one entry per action and no aggregate edit_session', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
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
      version: 1,
      kind: 'part',
      features: [
        { id: 'Origin', kind: 'origin' },
        { id: 'Top', kind: 'plane' },
        { id: 'Front', kind: 'plane' },
        { id: 'Right', kind: 'plane' },
        { id: 'f2', kind: 'extrude' },
      ],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'f2', toIndex: 4 }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('a same-color mutation pushes nothing and neither dirties nor re-solves', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    useUnsavedChangesStore.getState().setDirty(false)
    reSolve.mockClear()

    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(reSolve).not.toHaveBeenCalled()
  })

  it('applying a preview that changed nothing leaves no undo step', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }) })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a no-change color Apply pushes nothing and does not set dirty', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
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
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000', transparency: 0 } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
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

  it('an end-snapped line committed as a group is one undo step restoring both', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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
      version: 1,
      kind: 'part',
      features: [
        { id: 'f1', kind: 'sketch' },
        { id: 'f2', kind: 'extrude' },
        { id: 'f3', kind: 'fillet' },
        { id: 'f4', kind: 'chamfer' },
      ],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

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

  it('no-op visibility and suppression toggles push nothing and neither dirty nor re-solve', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      features: [{ id: 'f1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
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
      version: 1,
      kind: 'part',
      features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['?edge1'] } }],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation({ type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?edge1' }) })

    // The second add REMOVES the edge (toggle), a genuine change, so it pushes.
    expect(result.current.undoStack).toHaveLength(1)
    const fillet = (docRef.current.features?.[0] as { fillet: { edges: string[] } }).fillet
    expect(fillet.edges).toEqual([])
  })
})
