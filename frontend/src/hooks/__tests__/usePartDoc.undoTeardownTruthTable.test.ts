import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { act } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, renameTo, labelOf, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// Whether the editor comes down is the engine's decision (useUndoRedo's
// applyUndoRedo); the open-work commit only reports what it did. These tests
// pin that rule row by row so it stays a stated contract instead of an emergent
// property of two call sites.
//
// Nothing open, no move (rows 1-2): teardown must not fire. A keystroke that
// changes nothing may not clear the user's selection as a side effect.
// Nothing open, move (rows 3-4): one teardown, before the doc swaps.
// Commit, undo (rows 5-6): the commit's entry is on the undo stack, so the
// move proceeds and tears down on its normal path, exactly once. The flag must
// not add a second teardown there.
// Commit, redo (row 7): the commit's push cleared the redo branch the move is
// about to read, so the move cannot happen and the engine's guard stops it
// before its own teardown. The editor that commit consumed still has to come
// down, which is the whole reason the flag exists.
// Nothing pushed, redo (row 8): the flag stays false, so a session that changed
// nothing is not closed by a dead keystroke.
//
// The probe is the page teardown the funnel registers: usePartDoc's own
// tearDownEditorState calls it exactly once per teardown, so the call count is
// the number of teardowns rather than a proxy for one. It records the doc live
// at teardown time, which is what pins the before-the-swap ordering. `clear`
// drops the seed moves a test makes to build its history.
function renderDoc() {
  const view = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  const docsAtTeardown: PartDoc[] = []
  const teardown = vi.fn(() => { docsAtTeardown.push(docRef.current as PartDoc) })
  view.result.current.registerUndoTeardown(teardown)
  return {
    result: view.result,
    teardown,
    docsAtTeardown,
    clear: () => { teardown.mockClear(); docsAtTeardown.length = 0 },
  }
}

const labelIn = (doc: PartDoc | undefined) => (doc?.features?.[0] as { label?: string } | undefined)?.label

// An open suppressed session holding one real edit: the commit the open-work
// funnel resolves before a move.
function openSessionWithEdit(result: { current: ReturnType<typeof usePartDoc> }) {
  usePartEditorStore.getState().setEditingFeatureId('extrude-1')
  act(() => { result.current.startEditSession(true) })
  act(() => { result.current.handleMutation(renameTo('in-edit')) })
}

describe('usePartDoc undo teardown truth table', () => {
  beforeEach(resetHarness)

  it('row 1: undo with nothing open and nothing to undo tears nothing down', () => {
    const { result, teardown } = renderDoc()

    act(() => { result.current.handleUndo() })

    expect(teardown).not.toHaveBeenCalled()
  })

  it('row 2: redo with nothing open and no redo branch tears nothing down', () => {
    const { result, teardown } = renderDoc()

    act(() => { result.current.handleRedo() })

    expect(teardown).not.toHaveBeenCalled()
  })

  it('row 3: an undo that moves tears down once, before the doc swaps', () => {
    const { result, teardown, docsAtTeardown, clear } = renderDoc()

    act(() => { result.current.handleMutation(renameTo('edited')) })
    clear()
    act(() => { result.current.handleUndo() })

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(labelOf()).toBe('first')
    // The teardown saw the pre-undo doc, which is what makes it the contract-
    // bearing call: it nulls transient state first, and the engine then rewrites
    // the rollback position from the restored entry.
    expect(labelIn(docsAtTeardown[0])).toBe('edited')
    expect(docsAtTeardown[0]).not.toBe(docRef.current)
  })

  it('row 4: a redo that moves tears down once, before the doc swaps', () => {
    const { result, teardown, docsAtTeardown, clear } = renderDoc()

    act(() => { result.current.handleMutation(renameTo('edited')) })
    act(() => { result.current.handleUndo() })
    clear()
    act(() => { result.current.handleRedo() })

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(labelOf()).toBe('edited')
    expect(labelIn(docsAtTeardown[0])).toBe('first')
    expect(docsAtTeardown[0]).not.toBe(docRef.current)
  })

  it('row 5: an undo after the open session commits tears down exactly once, on the move', () => {
    const { result, teardown, docsAtTeardown } = renderDoc()
    openSessionWithEdit(result)

    act(() => { result.current.handleUndo() })

    // The commit pushed the session's aggregate onto an otherwise empty undo
    // stack, so the undo popped it and took its normal teardown.
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(result.current.undoStack).toHaveLength(0)
    expect(labelOf()).toBe('first')
    expect(labelIn(docsAtTeardown[0])).toBe('in-edit')
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
  })

  it('row 6: an undo whose commit sits on top of older entries moves and tears down once', () => {
    const { result, teardown } = renderDoc()

    act(() => { result.current.handleMutation(renameTo('older')) })
    openSessionWithEdit(result)
    act(() => { result.current.handleUndo() })

    expect(teardown).toHaveBeenCalledTimes(1)
    // The session's aggregate is the newest entry, so the undo reverted it and
    // left the older edit in place.
    expect(labelOf()).toBe('older')
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('row 7: a redo right after the open session commits tears the editor down exactly once', () => {
    const { result, teardown, docsAtTeardown, clear } = renderDoc()

    // Seed a redo branch for the commit to clear.
    act(() => { result.current.handleMutation(renameTo('first-edit')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    openSessionWithEdit(result)
    const postEdit = docRef.current
    clear()
    act(() => { result.current.handleRedo() })

    // The commit's push cleared the redo branch, so the redo cannot move and the
    // engine stops at its guard. The editor the commit consumed must still come
    // down, exactly once, or its OK goes inert and a stale popover keeps
    // swallowing later edits.
    expect(result.current.redoStack).toHaveLength(0)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
    expect(usePartEditorStore.getState().pickBoundary).toBeNull()
    // Nothing swapped on this path, so the teardown and the doc agree: the
    // commit's doc is still the live one.
    expect(docRef.current).toBe(postEdit)
    expect(docsAtTeardown).toEqual([postEdit])
    expect(labelOf()).toBe('in-edit')

    // The work the commit recorded is reachable by a plain undo afterwards.
    act(() => { result.current.handleUndo() })
    expect(labelOf()).toBe('first')
  })

  it('row 7a: a redo right after an open preview commits tears the editor down exactly once', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result, teardown, clear } = renderDoc()

    act(() => { result.current.handleMutation(renameTo('first-edit')) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    // The popover half of the same rule: a preview resolved by the commit is the
    // other open work whose entry clears the redo branch.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' } as Mutation) })
    clear()
    act(() => { result.current.handleRedo() })

    expect(result.current.redoStack).toHaveLength(0)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect((docRef.current.part_style?.b1 as { color?: string }).color).toBe('#00ff00')
  })

  it('row 8: a redo with a session open that pushed nothing tears nothing down', () => {
    const { result, teardown } = renderDoc()

    // Enter the edit without touching the doc: there is no open work to commit,
    // so the flag stays false and the dead keystroke is inert.
    usePartEditorStore.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleRedo() })

    expect(teardown).not.toHaveBeenCalled()
    expect(usePartEditorStore.getState().editingFeatureId).toBe('extrude-1')

    // The session is still live, so its next edit is swallowed as before.
    act(() => { result.current.handleMutation(renameTo('in-edit')) })
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.cancelEditSession() })
    expect(labelOf()).toBe('first')
  })
})