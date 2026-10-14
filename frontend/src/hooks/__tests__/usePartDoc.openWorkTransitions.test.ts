// The transition table of the open-work slot, row by row: idle, preview and
// session (suppressed or sketch), and what each machine action does to the
// successor state. The real DocSession and real mutation handlers; only the
// document and solver seams are mocked, like the other undo suites. The point
// of the union is that a colour preview and an edit session can never be open
// at once, so every row either refuses, resolves or swallows, and the
// single-ownership section pins that only the live variant's cancel is a real
// rewind. History moves and the brep withhold have their own truth-table
// suites; the moves here are the rows that commit open work first.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, renameTo, labelOf, resetHarness, reSolve } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// A doc with a body-style entry, so the PREVIEW_SCOPE mutations have something
// real to change.
const colorDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

const setColor = (color: string): Mutation =>
  ({ type: 'set_part_color', bodyId: 'b1', color }) as Mutation

const colorOf = (d: PartDoc | null = docRef.current): string | undefined =>
  (d?.part_style?.b1 as { color?: string } | undefined)?.color

const labelOfDoc = (d: PartDoc): string | undefined =>
  (d.features?.[0] as { label?: string } | undefined)?.label

const renderPartDoc = () => renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

describe('open-work transitions: idle', () => {
  beforeEach(resetHarness)
  beforeEach(() => { useUnsavedChangesStore.getState().setDirty(false) })

  it('startPreviewMode -> preview: scope mutations are swallowed until commit', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(docRef.current!) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitPreview(setColor('#00ff00')) })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['preview_commit'])
    expect(colorOf(result.current.undoStack[0].doc)).toBe('#ff0000')
  })

  it('startEditSession -> session: the session swallows its mutations', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-session')) })
    expect(labelOf()).toBe('in-session')
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('handleMutation -> idle: an idle edit pushes its own entry', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(renameTo('idle-edit')) })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature'])
  })

  it('commitPreview -> idle (throw), cancelPreview -> idle (inert): nothing to resolve', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    expect(() => result.current.commitPreview(setColor('#00ff00')))
      .toThrow(/commitPreview called with no active preview/)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect(colorOf()).toBe('#ff0000')
  })

  it('commitEditSession -> idle (no-op), cancelEditSession -> idle (re-solve only)', () => {
    docRef.current = colorDoc()
    reSolve.mockClear()
    const { result } = renderPartDoc()

    act(() => { result.current.commitEditSession() })
    act(() => { result.current.cancelEditSession() })

    // No session existed, so there is nothing to fold and nothing to rewind;
    // the cancel still re-solves the live doc for the viewport.
    expect(result.current.undoStack).toHaveLength(0)
    expect(labelOf()).toBe('first')
    expect(reSolve).toHaveBeenCalledWith(docRef.current)
  })
})

describe('open-work transitions: preview', () => {
  beforeEach(resetHarness)
  beforeEach(() => { useUnsavedChangesStore.getState().setDirty(false) })

  it('startPreviewMode -> preview (refused): the first baseline survives', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/nested preview/)

    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    act(() => { result.current.commitPreview(setColor('#00ff00')) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(colorOf(result.current.undoStack[0].doc)).toBe('#ff0000')
  })

  it('startEditSession -> session: the preview resolves with its own entry, then the session opens', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    act(() => { result.current.startEditSession(true) })

    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['preview_commit'])
    expect(colorOf(result.current.undoStack[0].doc)).toBe('#ff0000')
    // No preview survives the boundary; the popover's own Cancel is inert.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    // The session baseline is the resolved doc: a session cancel keeps the
    // colour and drops only the session edit.
    act(() => { result.current.handleMutation(renameTo('in-session')) })
    act(() => { result.current.cancelEditSession() })
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#00ff00')
  })

  it('commitPreview -> idle: pushes nothing when the preview never changed the doc', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.commitPreview(setColor('#ff0000')) })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('commitEditSession -> preview (inert): the preview survives and still owns the rewind', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelPreview() })
    expect(colorOf()).toBe('#ff0000')
  })

  it('startEditSession -> session over an untouched preview: no resolve entry, baseline is the live doc', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.startEditSession(true) })
    expect(result.current.undoStack).toHaveLength(0)

    // The session baseline is the doc at session start: cancelling the session
    // edit returns to it, colour untouched.
    act(() => { result.current.handleMutation(renameTo('in-session')) })
    act(() => { result.current.cancelEditSession() })
    expect(labelOf()).toBe('first')
    expect(colorOf()).toBe('#ff0000')
  })

  it('cancelPreview -> idle: rewinds to the baseline and restores the pinned dirty flag', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toEqual(colorDoc())
    expect(colorOf()).toBe('#ff0000')
    expect(result.current.undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('mutation outside PREVIEW_SCOPE -> idle: the preview commits, then the mutation lands normally', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    act(() => { result.current.handleMutation(renameTo('escaped')) })

    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['preview_commit', 'rename_feature'])
    // The preview entry restores the pre-preview doc; the escaped mutation's
    // entry restores the doc it landed on, colour already applied.
    expect(colorOf(result.current.undoStack[0].doc)).toBe('#ff0000')
    expect(colorOf(result.current.undoStack[1].doc)).toBe('#00ff00')
    expect(labelOf()).toBe('escaped')
    expect(colorOf()).toBe('#00ff00')

    // The escape consumed the preview: Cancel has nothing left to rewind.
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
  })

  it('mutation inside PREVIEW_SCOPE -> preview: swallowed and still cancellable', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.cancelPreview() })
    expect(colorOf()).toBe('#ff0000')
    expect(result.current.undoStack).toHaveLength(0)
  })
})

describe('open-work transitions: session', () => {
  beforeEach(resetHarness)
  beforeEach(() => { useUnsavedChangesStore.getState().setDirty(false) })

  it('startPreviewMode -> session (refused): the session keeps owning the doc', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    expect(() => {
      act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    }).toThrow(/startPreviewMode called while an edit session is active/)

    // The refused open tracked nothing: the session still swallows and folds
    // one aggregate whose restore point is the pre-session doc.
    act(() => { result.current.handleMutation(setColor('#00ff00')) })
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['edit_session'])
    expect(labelOfDoc(result.current.undoStack[0].doc)).toBe('first')
    expect(colorOf(result.current.undoStack[0].doc)).toBe('#ff0000')
  })

  it('commitEditSession -> idle: an untouched session pushes nothing', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('handleUndo -> moves: the open session folds its aggregate first, then the undo reverts it', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-session')) })

    act(() => { result.current.handleUndo() })

    // The aggregate is the newest entry, so the move popped it and the editor
    // is back at the pre-session doc with a redo entry to return.
    expect(labelOf()).toBe('first')
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack.map(e => e.mutation.type)).toEqual(['edit_session'])
  })

  it('startEditSession -> session (refused): nested sessions are not supported', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    expect(() => result.current.startEditSession(true)).toThrow(/nested edit session/)
  })

  it('commitPreview -> session (throw); cancelPreview -> session (inert)', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    expect(() => result.current.commitPreview(setColor('#0000ff')))
      .toThrow(/commitPreview called with no active preview/)
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()

    // Both inert calls left the session live: the next edit is still swallowed.
    act(() => { result.current.handleMutation(renameTo('still-swallowed')) })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('commitEditSession -> idle: a changed suppressed session folds one edit_session entry', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-session')) })
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['edit_session'])

    // The slot is idle again: the next edit pushes normally.
    act(() => { result.current.handleMutation(renameTo('after')) })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['edit_session', 'rename_feature'])
  })

  it('cancelEditSession -> idle: rewinds to the baseline and restores stacks and dirty', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(renameTo('kept')) })
    useUnsavedChangesStore.getState().setDirty(false)
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('kept')
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature'])
    expect(result.current.redoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)

    // Suppression is never sticky: after the cancel the next edit pushes.
    act(() => { result.current.handleMutation(renameTo('after-cancel')) })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature', 'rename_feature'])
    expect(labelOf()).toBe('after-cancel')
  })
})

describe('open-work transitions: sketch session', () => {
  beforeEach(resetHarness)
  beforeEach(() => { useUnsavedChangesStore.getState().setDirty(false) })

  it('startEditSession -> session (sketch): mutations push per action and commit adds no aggregate', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(false) })
    act(() => { result.current.handleMutation(renameTo('in-sketch-session')) })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature'])

    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature'])
  })

  it('cancelEditSession -> idle: rewinds the doc and restores the stacks parked at session start', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation(renameTo('kept')) })
    act(() => { result.current.startEditSession(false) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    expect(result.current.undoStack).toHaveLength(2)

    act(() => { result.current.cancelEditSession() })

    expect(labelOf()).toBe('kept')
    expect(result.current.undoStack.map(e => e.mutation.type)).toEqual(['rename_feature'])
  })
})

describe('open-work single ownership', () => {
  beforeEach(resetHarness)
  beforeEach(() => { useUnsavedChangesStore.getState().setDirty(false) })

  it('from preview, cancelPreview rewinds and cancelEditSession is inert', () => {
    docRef.current = colorDoc()
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation(setColor('#00ff00')) })

    // No session is open, so the session cancel cannot touch the doc...
    act(() => { result.current.cancelEditSession() })
    expect(colorOf()).toBe('#00ff00')

    // ...and the preview cancel owns the rewind.
    act(() => { result.current.cancelPreview() })
    expect(colorOf()).toBe('#ff0000')
  })

  it('from session, cancelEditSession rewinds and cancelPreview is inert', () => {
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('in-session')) })

    // No preview is open, so the preview cancel returns null and rewinds
    // nothing...
    let cancelled: PartDoc | null = null
    act(() => { cancelled = result.current.cancelPreview() })
    expect(cancelled).toBeNull()
    expect(labelOf()).toBe('in-session')

    // ...and the session cancel owns the rewind.
    act(() => { result.current.cancelEditSession() })
    expect(labelOf()).toBe('first')
  })
})
