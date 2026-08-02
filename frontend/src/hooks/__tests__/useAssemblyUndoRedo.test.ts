import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
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
    // The doc being left behind becomes the redo counterpart.
    expect(result.current.redoStack).toHaveLength(1)
    expect(result.current.redoStack[0].doc).toBe(docB)
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
