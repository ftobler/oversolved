import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

describe('useUndoRedo', () => {
  it('pushUndo adds to undoStack and clears redoStack', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude', featureId: 'f1' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)

    act(() => {
      result.current.pushUndo({ type: 'delete_feature', featureId: 'f2' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleUndo restores previous doc state', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'extrude' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA)
    })

    act(() => {
      result.current.handleUndo()
    })

    expect(setDoc).toHaveBeenCalledWith(docA)
    // reSolve reads rollback from the store; the test patches the store before
    // calling so verifying just doc-arg is sufficient.
    expect(reSolve).toHaveBeenCalledWith(docA)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    // The counterpart holds a snapshot of the departing doc, not a reference,
    // so a later in-place mutation of docB cannot corrupt the redo entry.
    expect(result.current.redoStack[0].doc).toEqual(docB)
    expect(result.current.redoStack[0].doc).not.toBe(docB)
    expect(docRef.current).toEqual(docA)
  })

  it('handleRedo restores next doc state', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docB = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docA }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
    })
    act(() => {
      result.current.handleUndo()
    })
    setDoc.mockClear()
    reSolve.mockClear()

    act(() => {
      result.current.handleRedo()
    })

    expect(setDoc).toHaveBeenCalledWith(docB)  // the docRef.current at time of undo
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('undo+redo round-trip preserves document', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA)
    })

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docA)

    act(() => {
      result.current.handleRedo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docB)
  })

  it('new mutation after undo clears redoStack', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docB = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
    })
    act(() => {
      result.current.handleUndo()
    })
    expect(result.current.redoStack).toHaveLength(1)

    setDoc.mockClear()
    reSolve.mockClear()

    act(() => {
      result.current.pushUndo({ type: 'new_mutation' } as unknown as Mutation, docRef.current!)
    })

    expect(result.current.redoStack).toHaveLength(0)
  })

  it('enforces max stack size', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    for (let i = 0; i < 55; i++) {
      act(() => {
        result.current.pushUndo({ type: 'add_sketch' } as Mutation, { version: 1, kind: 'part', features: [{ id: `f${i}`, kind: 'sketch' }] } as PartDoc)
      })
    }

    // Exact depth plus which end was discarded: a <= 50 bound also holds for an
    // empty stack, so it would pass even if nothing was ever pushed.
    expect(result.current.undoStack).toHaveLength(50)
    expect(result.current.undoStack[0].doc.features?.[0].id).toBe('f5')
    expect(result.current.undoStack[49].doc.features?.[0].id).toBe('f54')
  })

  it('suppressUndoRef does not gate pushUndo (gating happens in the mutation funnel)', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docRef.current!)
    })
    expect(result.current.undoStack).toHaveLength(1)

    result.current.suppressUndoRef.current = true

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(2)  // pushUndo still pushes, suppressUndoRef is not checked inside pushUndo
  })

  it('clearStacks empties both stacks', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.clearStacks() })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('clearStacks drops a parked edit-session snapshot too', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.saveUndoStackSnapshot() })
    act(() => { result.current.clearStacks() })

    // Cancelling the still-open session must not resurrect the history the code
    // tab just invalidated.
    act(() => { result.current.restoreUndoStackSnapshot() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('handleUndo on empty stack is no-op', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.handleUndo()
    })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('clearUndoStackSnapshot makes the parked restore a no-op', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.saveUndoStackSnapshot() })
    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA) })
    expect(result.current.undoStack).toHaveLength(2)

    // The code tab invalidated the parked session snapshot; a later cancel must
    // not rewind the stack to the one-entry pre-session content.
    act(() => { result.current.clearUndoStackSnapshot() })
    act(() => { result.current.restoreUndoStackSnapshot() })

    expect(result.current.undoStack).toHaveLength(2)
  })

  it('undo with a null docRef is a no-op that keeps the stacks paired', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
    const docRef = { current: null as PartDoc | null }
    const setDoc = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.handleUndo() })

    // A history with no current doc cannot be popped: moving the entry would
    // orphan its counterpart and permanently desync the paired stacks, so the
    // undo does nothing rather than dropping the entry.
    expect(setDoc).not.toHaveBeenCalled()
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleRedo on empty stack is no-op', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.handleRedo()
    })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(setDoc).not.toHaveBeenCalled()
  })

  // The whole file renders strict, but these target the double-invoke directly:
  // a transition that side-effects inside a setState updater replays and
  // duplicates entries, which a bare renderHook can never observe.
  describe('under StrictMode double-invocation', () => {
    it('undo pushes exactly one redo entry and redo returns exactly one', () => {
      const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
      const docB = { version: 1, kind: 'part', features: [{ id: 'f2' }] } as PartDoc
      const docRef = { current: docB }
      const setDoc = vi.fn()
      const reSolve = vi.fn()
      const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

      act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA) })
      expect(result.current.undoStack).toHaveLength(1)

      act(() => { result.current.handleUndo() })
      expect(result.current.undoStack).toHaveLength(0)
      expect(result.current.redoStack).toHaveLength(1)

      act(() => { result.current.handleRedo() })
      expect(result.current.undoStack).toHaveLength(1)
      expect(result.current.redoStack).toHaveLength(0)
    })

    it('repeated undo/redo cycles keep total entry count constant', () => {
      const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
      const docB = { version: 1, kind: 'part', features: [{ id: 'f2' }] } as PartDoc
      const docRef = { current: docB }
      const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
      const reSolve = vi.fn()
      const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

      act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA) })

      for (let i = 0; i < 5; i++) {
        act(() => { result.current.handleUndo() })
        act(() => { result.current.handleRedo() })
        expect(result.current.undoStack.length + result.current.redoStack.length).toBe(1)
      }
    })

    it('pushUndo adds one entry per call', () => {
      const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
      const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

      act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docRef.current!) })
      act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docRef.current!) })

      expect(result.current.undoStack).toHaveLength(2)
    })

    it('snapshot restore returns the stacks to their pre-session contents', () => {
      const docA = { version: 1, kind: 'part' } as PartDoc
      const docRef = { current: docA }
      const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

      act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
      act(() => { result.current.saveUndoStackSnapshot() })
      act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA) })
      expect(result.current.undoStack).toHaveLength(2)

      act(() => { result.current.restoreUndoStackSnapshot() })
      expect(result.current.undoStack).toHaveLength(1)
      expect(result.current.redoStack).toHaveLength(0)
    })

    it('snapshot taken right after a mutation includes that mutation', () => {
      const docA = { version: 1, kind: 'part' } as PartDoc
      const docRef = { current: docA }
      const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

      // Same tick: the snapshot must read the ref, not the not-yet-rendered state.
      act(() => {
        result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
        result.current.saveUndoStackSnapshot()
        result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA)
      })
      act(() => { result.current.restoreUndoStackSnapshot() })

      expect(result.current.undoStack).toHaveLength(1)
    })
  })

  it('multiple undos in sequence work correctly', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docC = { version: 1, kind: 'part', features: [{ id: 'f3', kind: 'fillet' }] } as PartDoc
    const docRef = { current: docC }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docB)
    })

    expect(result.current.undoStack).toHaveLength(2)

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docB)
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(1)

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docA)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(2)
  })

  it('pushUndo stores a clone, so mutating the source doc later cannot corrupt the entry', () => {
    const sourceDoc = { version: 1, kind: 'part', features: [{ id: 'f1', label: 'before' }] } as PartDoc
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'rename_feature' } as Mutation, sourceDoc) })
    // A future path that mutates the current doc in place must not rewrite
    // history: the entry holds an independent snapshot.
    sourceDoc.features![0].label = 'corrupted'
    expect((result.current.undoStack[0].doc.features![0] as { label: string }).label).toBe('before')
  })

  it('undo pairs a clone of the departing doc onto the redo stack', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2' }] } as PartDoc
    const docRef = { current: docB }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.handleUndo() })

    // The counterpart captured the departing doc by value; later mutation of
    // docB must not alter what redo would restore.
    expect(result.current.redoStack[0].doc).not.toBe(docB)
    docB.features![0].id = 'corrupted'
    expect((result.current.redoStack[0].doc.features![0] as { id: string }).id).toBe('f2')
  })

  it('undo always sets the doc dirty, even when it restores the exact saved content', () => {
    // The saved content this session started from; the undo restores it
    // verbatim, so a smart flag would clear. The conservative rule keeps the
    // doc unsaved instead, because nothing retains the saved content to diff
    // against, and the pin acknowledges that trade-off.
    const saved = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const edited = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch', label: 'edited' }] } as PartDoc
    const docRef = { current: edited }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'rename_feature' } as Mutation, saved) })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleUndo() })

    expect(docRef.current).toEqual(saved)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('redo also sets the doc dirty', () => {
    const saved = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const edited = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch', label: 'edited' }] } as PartDoc
    const docRef = { current: edited }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'rename_feature' } as Mutation, saved) })
    act(() => { result.current.handleUndo() })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleRedo() })

    // Redo restores the post-edit doc, moving it away from the saved content
    // exactly like undo does, so it must warn too.
    expect(docRef.current).toEqual(edited)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('undo invalidates a parked stack snapshot so a later restore is inert', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2' }] } as PartDoc
    const docRef = { current: docB }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.saveUndoStackSnapshot() })
    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docB) })
    expect(result.current.undoStack).toHaveLength(2)

    act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(1)

    // The undo exited the open session, so the parked snapshot is dead;
    // restoring it must not rewind the stacks to their pre-session contents.
    act(() => { result.current.restoreUndoStackSnapshot() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(1)
  })

  it('undo clamps a stale restored rollback to the restored feature count', () => {
    // A hand-edited doc can carry rollback past the feature list (Part.tsx
    // clamps the STORE on load, but the DOC is loaded verbatim). Restoring it
    // must clamp the bar to the end, never overshoot into empty space.
    const staleDoc = {
      version: 1, kind: 'part', rollback: 5,
      features: [
        { id: 'f1', kind: 'sketch' },
        { id: 'f2', kind: 'extrude' },
        { id: 'f3', kind: 'fillet' },
      ],
    } as PartDoc
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, staleDoc) })
    usePartEditorStore.getState().setRollbackPosition(99)

    act(() => { result.current.handleUndo() })

    expect(usePartEditorStore.getState().rollbackPosition).toBe(3)
  })

  it('undo without a stored rollback parks the bar at the end of the restored features', () => {
    const plainDoc = {
      version: 1, kind: 'part',
      features: [
        { id: 'f1', kind: 'sketch' },
        { id: 'f2', kind: 'extrude' },
      ],
    } as PartDoc
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, plainDoc) })
    act(() => { result.current.handleUndo() })

    // Absent rollback means "at the end of the stack", so the restore lands on
    // the restored doc's own feature count, not on a stale store position.
    expect(usePartEditorStore.getState().rollbackPosition).toBe(2)
  })

  it('restoreUndoStackSnapshot only re-pairs the stacks; the caller must rewind the doc first', () => {
    // PAIRING CONTRACT: the stacks only describe the pre-session doc again once
    // the live doc IS that doc. This restore commits the stacks and nothing
    // else, so a caller that restores without first rewinding docRef leaves the
    // top entry naming a doc the live doc is not. cancelEditSession composes
    // doc rewind + stack restore into one unit; any future caller must too.
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2' }] } as PartDoc
    const docRef = { current: docB }
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA) })
    act(() => { result.current.saveUndoStackSnapshot() })
    act(() => { result.current.pushUndo({ type: 'add_extrude' } as Mutation, docB) })
    expect(result.current.undoStack).toHaveLength(2)

    act(() => { result.current.restoreUndoStackSnapshot() })

    // The pre-session stack is back, whose top entry is docA, but the live doc
    // is still docB: restore does not touch the doc. The undo that follows
    // would pop to docA, so the rewind must precede the restore.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].doc).toEqual(docA)
    expect(docRef.current).toEqual(docB)
  })
})
