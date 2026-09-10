import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyUndoRedo, decideAssemblyMutation } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { findInstance, findMate } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM, rotateVector } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

// The module store holds the stacks, so every test must start from an empty
// one: setSnapshot preserves the stacks (they are store-owned).
function resetStore() {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({
    undoStack: [], redoStack: [],
    subject: null, activeMateField: null, mateFieldDirty: false,
    pickCandidates: [], pickIndex: -1,
    editingSubject: { kind: 'none' },
  })
  useUnsavedChangesStore.getState().setDirty(false)
  setAssemblyCallbacks(null)
}

function docWith(featureIds: string[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: featureIds.map(id => ({ id, kind: 'part_instance', instance: {
      handle: id, doc_id: `d-${id}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
    } })),
  }
}

describe('useAssemblyUndoRedo', () => {
  beforeEach(resetStore)
  it('pushUndo adds to undoStack and clears redoStack', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo(docRef.current!, 'Add part') })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].label).toBe('Add part')

    act(() => { result.current.handleUndo() })  // fills the redo branch
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.pushUndo(docRef.current!, 'Add part') })
    expect(result.current.undoStack).toHaveLength(1)
    // A fresh edit invalidates any redo branch.
    expect(result.current.redoStack).toHaveLength(0)
  })

  // The entry holds a snapshot, never a reference: every caller passes the
  // live docRef object, so sharing it would let an unchecked in-place mutation
  // silently rewrite what undo restores. Mirrors the part editor's pushUndo
  // clone and applyUndoRedo's counterpart clone.
  it('pushUndo stores a clone so a later in-place edit cannot rewrite history', () => {
    const live = docWith(['a'])
    const docRef = { current: live }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo(docRef.current!, 'Add part') })

    const entry = result.current.undoStack[0]
    expect(entry.doc).not.toBe(live)
    expect(entry.doc).toEqual(live)

    // Mutate a nested field of the live doc IN PLACE, the way an unchecked
    // code path would; the stored snapshot must not move with it.
    const inst = live.features![0] as { instance: { handle: string } }
    inst.instance.handle = 'mutated'
    expect(result.current.undoStack[0].doc).toEqual(docWith(['a']))
  })

  it('handleUndo restores the previous doc, mirrors the counterpart and re-solves', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const requestSolve = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })

    expect(setDoc).toHaveBeenCalledWith(docA)
    // The restored doc IS the stored snapshot: equal to docA but no longer the
    // same object, because entries hold clones that must never alias the live
    // document (see the pushUndo snapshot test above).
    expect(docRef.current).toEqual(docA)
    expect(docRef.current).not.toBe(docA)
    expect(requestSolve).toHaveBeenCalledTimes(1)  // the restore must re-solve
    expect(result.current.undoStack).toHaveLength(0)
    // The doc being left behind becomes the redo counterpart. The counterpart
    // holds a snapshot, not a reference, so a later in-place mutation of docB
    // cannot corrupt the entry redo would restore.
    expect(result.current.redoStack).toHaveLength(1)
    expect(result.current.redoStack[0].doc).toEqual(docB)
    expect(result.current.redoStack[0].doc).not.toBe(docB)
  })

  it('handleRedo restores the next doc', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    setDoc.mockClear()

    act(() => { result.current.handleRedo() })
    // The doc that was current at undo time is the redo target.
    expect(setDoc).toHaveBeenCalledWith(docB)
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('a new mutation after undo clears the redo branch', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.pushUndo(docRef.current!, 'Add part') })
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('enforces max stack size', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    for (let i = 0; i < 55; i++) {
      act(() => { result.current.pushUndo(docWith([`f${i}`]), `op ${i}`) })
    }

    expect(result.current.undoStack).toHaveLength(50)
    // The oldest entries are discarded, not the newest.
    expect(result.current.undoStack[0].label).toBe('op 5')
    expect(result.current.undoStack[49].label).toBe('op 54')
  })

  it('handleUndo on an empty stack is a no-op', () => {
    const docRef = { current: docWith(['a']) }
    const setDoc = vi.fn()
    const requestSolve = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))

    act(() => { result.current.handleUndo() })

    expect(setDoc).not.toHaveBeenCalled()
    expect(requestSolve).not.toHaveBeenCalled()
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleRedo on an empty stack is a no-op', () => {
    const docRef = { current: docWith(['a']) }
    const setDoc = vi.fn()
    const requestSolve = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))

    act(() => { result.current.handleRedo() })

    expect(setDoc).not.toHaveBeenCalled()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('restoring a snapshot sets the dirty flag', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })

    // An undo moves the doc away from the saved content, so it must warn.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('redo also sets the dirty flag', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleRedo() })

    // Redo restores the post-edit doc, moving it away from the saved content
    // exactly like undo does, so it must warn too.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('undo disarms the mate-authoring state so no pick aims into a vanished feature', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => {
      useAssemblyStore.setState({
        activeMateField: { featureId: 'ghost', field: 'ref_a' },
        mateFieldDirty: true,
        pickCandidates: [{ part: 'a', anchor: 'a_v' }],
        pickIndex: 0,
      })
      result.current.pushUndo(docA, 'Add part')
    })
    act(() => { result.current.handleUndo() })

    expect(useAssemblyStore.getState().activeMateField).toBeNull()
    expect(useAssemblyStore.getState().mateFieldDirty).toBe(false)
    expect(useAssemblyStore.getState().pickCandidates).toEqual([])
    expect(useAssemblyStore.getState().pickIndex).toBe(-1)
    expect(useAssemblyStore.getState().subject).toBeNull()
  })

  // applyUndoRedo's transient-field reset must delegate to the store's own
  // resetTransientAssemblyState rather than hand-listing fields, or it silently
  // drifts from STORE_OWNED_FIELDS (which happened: showPickDebug was missing).
  // Pinning this one field proves the reset now covers the full owned set.
  it('undo resets showPickDebug along with the rest of the store-owned transient state', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => {
      useAssemblyStore.setState({ showPickDebug: true })
      result.current.pushUndo(docA, 'Add part')
    })
    act(() => { result.current.handleUndo() })

    expect(useAssemblyStore.getState().showPickDebug).toBe(false)
  })

  // The selection fields live outside the doc, so an undo that removes the
  // selected part must not leave them naming entities the restored doc lacks.
  it('undo of an insert clears the B-rep selection, hover and selected part handle', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => {
      useAssemblyStore.setState({
        entitySelection: new Set([assemblyEntityKey('b', 0, 'face', 0)]),
        hoveredEntity: assemblyEntityKey('b', 0, 'face', 0),
        subject: { kind: 'part', handle: 'b' },
      })
      result.current.pushUndo(docA, 'Add part')
    })
    act(() => { result.current.handleUndo() })

    const after = useAssemblyStore.getState()
    // The restored doc has no part b, so nothing may keep selecting or hovering it.
    expect(after.entitySelection.size).toBe(0)
    expect(after.hoveredEntity).toBeNull()
    expect(after.subject).toBeNull()
  })

  // The deleted instance's handle and its B-rep selection must not survive the
  // undo that brings the pre-delete doc back: the selection keys are positional
  // and would re-resolve to whatever geometry now occupies the renumbered slots.
  it('undo of a delete leaves the deleted instance unselected and no selection key names a vanished body', () => {
    const initial = docWith(['a', 'b'])
    const requestSolve = vi.fn()
    const docRef = { current: initial }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))
    const { pushUndo } = result.current

    // Stands in for the page's mutate: captures the pre-doc, then applies.
    const pageMutate = (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const cur = docRef.current!
      pushUndo(cur, label)
      docRef.current = fn(cur)
      setDoc(docRef.current)
      useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: docRef.current })
    }
    setAssemblyCallbacks({ mutateDoc: pageMutate, mutateDocSession: pageMutate, requestSolve })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })

    const bFace = assemblyEntityKey('b', 0, 'face', 0)
    act(() => {
      useAssemblyStore.getState().selectPart('b')
      useAssemblyStore.setState({
        entitySelection: new Set([bFace]),
        hoveredEntity: bFace,
      })
      useAssemblyStore.getState().deleteSelected()
    })
    expect((docRef.current!.features ?? []).some(f => f.kind === 'part_instance' && f.instance?.handle === 'b'))
      .toBe(false)

    act(() => { result.current.handleUndo() })
    const after = useAssemblyStore.getState()
    // The restored doc has part b again, but the selection must not aim into it.
    expect((docRef.current!.features ?? []).some(f => f.kind === 'part_instance' && f.instance?.handle === 'b'))
      .toBe(true)
    expect(after.subject).toBeNull()
    expect(after.entitySelection.size).toBe(0)
    expect(after.hoveredEntity).toBeNull()
  })

  it('undo discards a pending coalesced session so a later commit pushes nothing stale', () => {
    const docA = docWith(['a'])
    const docRef = { current: docWith(['a', 'b']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => {
      // A mate editor is open and its first keystroke pinned a session entry.
      result.current.recordSessionEdit(docRef.current!, 'Edit mate')
    })
    act(() => { result.current.handleUndo() })

    expect(result.current.undoStack).toHaveLength(0)

    // The stale session must not resurrect itself on a later OK click.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  // Redo shares the session-drop with undo (applyUndoRedo's first line), but
  // only the undo leg was pinned: a redo mid-edit must abandon the coalesced
  // session the same way, or the commit of its stale pre-doc lands on the
  // doc the redo just restored and duplicates history.
  it('redo discards a pending coalesced session so a later commit pushes nothing stale', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    // A mate editor is open and its first keystroke pinned a session entry.
    act(() => { result.current.recordSessionEdit(docRef.current!, 'Edit mate') })
    act(() => { result.current.handleRedo() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)

    // The stale session must not resurrect itself on a later OK click.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('undo on an empty stack still drops a pinned coalescing session', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    // An editor on a fresh document pins a session on its first edit even
    // though the undo stack is empty.
    act(() => { result.current.recordSessionEdit(docRef.current!, 'Edit mate') })
    act(() => { result.current.handleUndo() })

    // The empty-stack undo must not leave the session pinned: a later OK would
    // otherwise push a stale pre-session doc with a label that matches nothing.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  // "Undo always exits an open editor" must hold even when the stack is empty:
  // the restore path never runs, so the editing subject has to be reset before
  // the early return or the editor would outlive the undo.
  it('undo on an empty stack still exits the open editor', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))
    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    expect(useAssemblyStore.getState().editingSubject.kind).toBe('instance')

    act(() => { result.current.handleUndo() })

    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'none' })
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('redo on an empty stack still exits the open editor', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))
    act(() => { useAssemblyStore.getState().openMateEditor('m1') })
    expect(useAssemblyStore.getState().editingSubject.kind).toBe('mate')

    act(() => { result.current.handleRedo() })

    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'none' })
  })

  it('cancelSession drops the pinned session and pushes nothing', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.recordSessionEdit(docRef.current!, 'Edit mate') })
    act(() => { result.current.cancelSession() })
    // Cancel rewound the doc to the pin, so closing the editor must not charge
    // an entry to the dropped session.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  // The cancel owns the rewind, so a partial revert by the caller cannot
  // under-revert what the session touched (the instance editor's controls bake
  // EVERY non-fixed instance's seed, not just the edited one's). Doc, dirty flag
  // and pin move as one unit; the stacks stay put because a pinned session
  // pushed nothing, so they already describe the doc becoming live again.
  it('cancelSession rewinds the doc and the dirty flag to the pin, leaving the stacks alone', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docA }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })  // history predating the editor
    act(() => { result.current.recordSessionEdit(docA, 'Set position') })
    // What the page's `mutate` does after pinning: apply the edit, mark dirty.
    docRef.current = docB
    useUnsavedChangesStore.getState().setDirty(true)

    act(() => { result.current.cancelSession() })

    expect(setDoc).toHaveBeenCalledWith(docA)
    expect(docRef.current).toBe(docA)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Add part'])
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('cancelSession with no pinned session rewinds nothing', () => {
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    // Cancel on an editor that changed nothing: no pin, so there is no
    // pre-session doc to go back to and no flag that was set on its behalf.
    useUnsavedChangesStore.getState().setDirty(true)
    act(() => { result.current.cancelSession() })

    expect(setDoc).not.toHaveBeenCalled()
    expect(docRef.current).toBe(docB)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  // Why the flag is pinned by the session's first edit rather than by the editor
  // opening: a one-shot landing in between is a real unsaved change with its own
  // undo entry, and the cancel has no business marking the document clean again.
  it('cancelSession restores the dirty flag as of the pin, not of the editor open', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docC = docWith(['a', 'b', 'c'])
    const docRef = { current: docA }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    // The editor opened on a saved doc, then a one-shot (a tree visibility
    // toggle) landed before the first session edit.
    act(() => { result.current.pushUndo(docA, 'Toggle visibility') })
    docRef.current = docB
    useUnsavedChangesStore.getState().setDirty(true)

    act(() => { result.current.recordSessionEdit(docB, 'Set position') })
    docRef.current = docC

    act(() => { result.current.cancelSession() })

    expect(docRef.current).toBe(docB)  // back to the one-shot's doc, not the saved one
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('cancelSession with a null live doc drops the pin and rewinds nothing', () => {
    const docRef = { current: null }
    const setDoc = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    // The doc went away while the editor was pinned, mirroring commitSession's
    // null-doc no-op: there is nothing left to rewind it to.
    act(() => { result.current.recordSessionEdit(docWith(['a']), 'Edit mate') })
    act(() => { result.current.cancelSession() })

    expect(setDoc).not.toHaveBeenCalled()
    expect(docRef.current).toBeNull()

    // The pin went with it: a later commit pushes nothing.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  // The unmount path: AssemblyEditor's cleanup commits the pinned session before
  // nulling its callbacks, so a navigation with an editor open leaves exactly
  // one coalesced entry rather than dropping the edits from undo forever.
  it('committing on unmount folds a pending session into exactly one entry with no orphan pin', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.recordSessionEdit(docA, 'Edit mate') })
    docRef.current = docB  // the typed offset applied to the live doc

    act(() => { result.current.commitSession() })
    // The unmount commit is the editor's close: one coalesced entry.
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Edit mate'])
    // The doc still holds the edit; committing only resolved the pin.
    expect(docRef.current).toEqual(docB)

    // No orphan pin remains: a later commit is a no-op.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('commitSession with a null live doc drops the pin and pushes nothing', () => {
    const docRef = { current: null }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    // The doc went away while the editor was pinned (a teardown after a failed
    // load): committing must not record an entry keyed to a doc that no longer
    // exists, mirroring applyUndoRedo's null-doc no-op.
    act(() => { result.current.recordSessionEdit(docWith(['a']), 'Edit mate') })
    act(() => { result.current.commitSession() })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // The pin was dropped with the entry: a later commit pushes nothing either.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('committing one editor then cancelling a later editor keeps both steps separate', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    // Page flow for "instance editor open, then insert mate": session A is the
    // instance editor (closed and committed by the insert), session B is the
    // mate editor (dropped by its Cancel).
    act(() => { result.current.recordSessionEdit(docA, 'Edit instance') })
    docRef.current = docB  // the instance edit applied
    act(() => {
      result.current.commitSession()  // the insert closes session A
      result.current.pushUndo(docRef.current!, 'Add mate')  // the insert's own step
      result.current.recordSessionEdit(docRef.current!, 'Edit mate')  // session B pins
    })
    act(() => { result.current.cancelSession() })  // Cancel drops only session B

    expect(result.current.undoStack.map(e => e.label)).toEqual(['Edit instance', 'Add mate'])

    // A later OK on the cancelled editor must not push a stale entry.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Edit instance', 'Add mate'])
    expect(result.current.redoStack).toHaveLength(0)
  })

  // The stale-scene regression: undoing a drag restores the pre-drag seed doc
  // while the store still holds the post-drag solved scene, so the viewport
  // renders the dragged pose until a solve runs. Undo MUST ask for that solve.
  // Driven through the store's real delete/drag funnels, as assemblyManipulation
  // does, so the labels and pre-docs come from production code.
  it('delete mate then gizmo drag: two undos revert both, each requesting a re-solve', () => {
    const initial: AssemblyDoc = {
      kind: 'assembly',
      features: [
        { id: 'fp1', kind: 'part_instance', instance: {
          handle: 'p1', doc_id: 'd1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
        } },
        { id: 'm1', kind: 'mate', mate: {
          kind: 'fixed', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p1', anchor: 'a2' },
        } },
      ],
    }
    const requestSolve = vi.fn()
    const docRef = { current: initial }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))
    const { pushUndo } = result.current

    // Stands in for the page's mutate: captures the pre-doc, then applies.
    const pageMutate = (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const cur = docRef.current!
      pushUndo(cur, label)
      docRef.current = fn(cur)
      setDoc(docRef.current)
      useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: docRef.current })
    }
    setAssemblyCallbacks({ mutateDoc: pageMutate, mutateDocSession: pageMutate, requestSolve })

    const p1Tx = (d: AssemblyDoc): number =>
      (d.features ?? []).find(f => f.kind === 'part_instance' && f.instance?.handle === 'p1')!
        .instance!.transform.tx
    const hasMate = (d: AssemblyDoc): boolean =>
      (d.features ?? []).some(f => f.kind === 'mate' && f.id === 'm1')

    act(() => { useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial }) })

    act(() => {
      useAssemblyStore.getState().selectMate('m1')
      useAssemblyStore.getState().deleteSelected()
    })
    act(() => {
      const s = useAssemblyStore.getState()
      s.beginPartManipulation('p1')
      s.dragPartTranslate([3, 0, 0])
      s.endPartManipulation()
    })

    expect(result.current.undoStack.map(e => e.label)).toEqual(['Delete mate', 'Move part'])
    expect(hasMate(docRef.current!)).toBe(false)
    expect(p1Tx(docRef.current!)).toBeCloseTo(3, 9)

    const solvesAfterOps = requestSolve.mock.calls.length

    act(() => { result.current.handleUndo() })
    expect(p1Tx(docRef.current!)).toBeCloseTo(0, 9)  // the drag is reverted
    expect(hasMate(docRef.current!)).toBe(false)
    expect(requestSolve.mock.calls.length).toBe(solvesAfterOps + 1)  // the stale-scene guard

    act(() => { result.current.handleUndo() })
    expect(hasMate(docRef.current!)).toBe(true)  // the delete is reverted
    expect(requestSolve.mock.calls.length).toBe(solvesAfterOps + 2)
  })

  // The gizmo-rotation undo step, driven through the same store funnel as the
  // drag test above. assemblyManipulation.test.ts asserts the committed
  // quaternion; this pins that the commit hands the stack ONE pre-rotation doc
  // whose undo restores the identity transform.
  it('a committed gizmo rotation pushes one entry and undo reverts the quaternion', () => {
    const initial: AssemblyDoc = {
      kind: 'assembly',
      features: [
        { id: 'fp1', kind: 'part_instance', instance: {
          handle: 'p1', doc_id: 'd1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
        } },
      ],
    }
    const requestSolve = vi.fn()
    const docRef = { current: initial }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))
    const { pushUndo } = result.current

    // Stands in for the page's mutate: captures the pre-doc, then applies.
    const pageMutate = (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const cur = docRef.current!
      pushUndo(cur, label)
      docRef.current = fn(cur)
      setDoc(docRef.current)
      useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: docRef.current })
    }
    setAssemblyCallbacks({ mutateDoc: pageMutate, mutateDocSession: pageMutate, requestSolve })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })

    act(() => {
      const s = useAssemblyStore.getState()
      s.beginPartManipulation('p1')
      s.rotatePartGizmo([0, 0, 1], Math.PI / 2)
      s.endPartManipulation()
    })

    // One entry with the pre-rotation doc and the shared drag label.
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Move part'])
    expect(result.current.undoStack[0].doc).toEqual(initial)
    const q = findInstance(docRef.current!, 'p1')!.transform
    const x = rotateVector([q.qx, q.qy, q.qz, q.qw], [1, 0, 0])
    expect(x[0]).toBeCloseTo(0, 9)
    expect(x[1]).toBeCloseTo(1, 9)

    act(() => { result.current.handleUndo() })
    // The pre-rotation doc is back: the identity transform, not the turned one.
    expect(findInstance(docRef.current!, 'p1')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
  })

  // "Pick mate reference" folds into the open coalescing session: every pick
  // routes through the store's commitAimToMateField to mutateDocSession, whose
  // real page funnel records the session edit instead of pushing. The stack
  // gets exactly one entry per editor close, restoring the pre-session doc.
  it('ref picks folding into the session coalesce into one entry that undo reverts to the pre-session doc', () => {
    const initial: AssemblyDoc = {
      kind: 'assembly',
      features: [
        { id: 'fp1', kind: 'part_instance', instance: {
          handle: 'p1', doc_id: 'd1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
        } },
        { id: 'fp2', kind: 'part_instance', instance: {
          handle: 'p2', doc_id: 'd2', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
        } },
        { id: 'm1', kind: 'mate', mate: {
          kind: 'spherical', ref_a: { part: '', anchor: '' }, ref_b: { part: '', anchor: '' },
        } },
      ],
    }
    const VERT_A = assemblyEntityKey('p1', 0, 'vertex', 0)
    const VERT_B = assemblyEntityKey('p2', 0, 'vertex', 0)
    const requestSolve = vi.fn()
    const docRef = { current: initial }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))
    const { pushUndo, recordSessionEdit } = result.current

    // The page funnel: an editor is open, so ref picks are session edits that
    // pin only the FIRST pre-pick doc; anything else pushes immediately.
    const oneShot = (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const cur = docRef.current!
      pushUndo(cur, label)
      docRef.current = fn(cur)
      setDoc(docRef.current)
      useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: docRef.current })
    }
    const sessionEdit = (label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const cur = docRef.current!
      recordSessionEdit(cur, label)
      docRef.current = fn(cur)
      setDoc(docRef.current)
      useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: docRef.current })
    }
    setAssemblyCallbacks({ mutateDoc: oneShot, mutateDocSession: sessionEdit, requestSolve })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })
    act(() => {
      useAssemblyStore.getState().setSolveResult({
        transforms: {}, bodies: {}, edgeCurves: {}, anchors: {}, pickGeometry: [],
        entityMateRefs: {
          [VERT_A]: [{ part: 'p1', anchor: 'a_v' }],
          [VERT_B]: [{ part: 'p2', anchor: 'b_v' }],
        },
        solveStatus: null,
      })
    })

    act(() => {
      const s = useAssemblyStore.getState()
      s.setActiveMateField({ featureId: 'm1', field: 'ref_a' })
      s.pickFromHitsOrCycle([{ entityKey: VERT_A }])
      s.setActiveMateField({ featureId: 'm1', field: 'ref_b' })
      s.pickFromHitsOrCycle([{ entityKey: VERT_B }])
    })
    expect(findMate(docRef.current!, 'm1')!.ref_a).toEqual({ part: 'p1', anchor: 'a_v' })
    expect(findMate(docRef.current!, 'm1')!.ref_b).toEqual({ part: 'p2', anchor: 'b_v' })
    // Both picks stay coalesced behind the open editor: no entry yet.
    expect(result.current.undoStack).toHaveLength(0)

    // Closing the editor (OK) commits exactly one coalesced entry.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].label).toBe('Pick mate reference')
    // The entry restores the pre-session doc: both refs still empty.
    expect(result.current.undoStack[0].doc).toEqual(initial)

    act(() => { result.current.handleUndo() })
    expect(findMate(docRef.current!, 'm1')!.ref_a).toEqual({ part: '', anchor: '' })
    expect(findMate(docRef.current!, 'm1')!.ref_b).toEqual({ part: '', anchor: '' })
  })
})

describe('decideAssemblyMutation', () => {
  it('is a no-op for an identical reference', () => {
    const doc = docWith(['a'])
    expect(decideAssemblyMutation({ pre: doc, next: doc, sessionOpen: false })).toBe('noop')
  })

  it('is a no-op for a structurally equal fresh reference', () => {
    expect(decideAssemblyMutation({
      pre: docWith(['a']), next: docWith(['a']), sessionOpen: false,
    })).toBe('noop')
  })

  it('pushes a changed doc when no session is open', () => {
    expect(decideAssemblyMutation({
      pre: docWith(['a']), next: docWith(['a', 'b']), sessionOpen: false,
    })).toBe('push')
  })

  it('folds a changed doc into an open session', () => {
    expect(decideAssemblyMutation({
      pre: docWith(['a']), next: docWith(['a', 'b']), sessionOpen: true,
    })).toBe('fold')
  })

  it('is a no-op when either side has no doc', () => {
    expect(decideAssemblyMutation({ pre: null, next: docWith(['a']), sessionOpen: false })).toBe('noop')
    expect(decideAssemblyMutation({ pre: docWith(['a']), next: null, sessionOpen: true })).toBe('noop')
    expect(decideAssemblyMutation({ pre: null, next: null, sessionOpen: true })).toBe('noop')
  })
})
