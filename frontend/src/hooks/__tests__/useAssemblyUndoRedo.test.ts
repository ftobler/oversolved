import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

// The module store holds the stacks, so every test must start from an empty
// one: setSnapshot preserves the stacks (they are store-owned).
function resetStore() {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({
    undoStack: [], redoStack: [],
    selectedMateId: null, activeMateField: null, mateFieldDirty: false,
    pickCandidates: [], pickIndex: -1,
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
    expect(docRef.current).toBe(docA)
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
    expect(useAssemblyStore.getState().selectedMateId).toBeNull()
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
        selection: new Set([assemblyEntityKey('b', 0, 'face', 0)]),
        hoveredEntity: assemblyEntityKey('b', 0, 'face', 0),
        selectedPartHandle: 'b',
      })
      result.current.pushUndo(docA, 'Add part')
    })
    act(() => { result.current.handleUndo() })

    const after = useAssemblyStore.getState()
    // The restored doc has no part b, so nothing may keep selecting or hovering it.
    expect(after.selection.size).toBe(0)
    expect(after.hoveredEntity).toBeNull()
    expect(after.selectedPartHandle).toBeNull()
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
      useAssemblyStore.getState().setSelectedPartHandle('b')
      useAssemblyStore.setState({
        selection: new Set([bFace]),
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
    expect(after.selectedPartHandle).toBeNull()
    expect(after.selection.size).toBe(0)
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

  it('cancelSession drops the pinned session and pushes nothing', () => {
    const docRef = { current: docWith(['a']) }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.recordSessionEdit(docRef.current!, 'Edit mate') })
    act(() => { result.current.cancelSession() })
    // Cancel already reverted the edits via its snapshot, so closing the editor
    // must not charge an entry to the dropped session.
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
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
      useAssemblyStore.getState().setSelectedMateId('m1')
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
})
