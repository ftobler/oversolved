import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { assemblyDocEquals, setInstancePosition, setInstanceVisible, setMateLabel } from '@/utils/assemblyMutations'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import type { AssemblyDoc } from '@/types/cad'

// The counterpart cap is observable only when it is small; at 50 a
// `<= MAX_UNDO_DEPTH` assertion is vacuous, exactly as in the part hook's
// useUndoRedo.undoCap.test.ts.
vi.mock('@/config/undoConfig', () => ({ MAX_UNDO_DEPTH: 3 }))

function resetStore() {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({
    undoStack: [], redoStack: [],
    subject: null, activeMateField: null, mateFieldDirty: false,
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

describe('assembly dead undo entries', () => {
  beforeEach(resetStore)

  // The funnel's content-level no-op guard is backed by this compare: every
  // assemblyMutations function mints a fresh doc even for a value no-op, so the
  // page's `next === current` reference fast path alone cannot catch it.
  it('assemblyDocEquals sees a same-value mutation as equal', () => {
    const doc = docWith(['a'])
    const same = setInstanceVisible(doc, 'a', true)
    expect(same).not.toBe(doc)  // the mutation mints a fresh doc...
    expect(assemblyDocEquals(doc, same)).toBe(true)  // ...that is structurally a no-op
    expect(assemblyDocEquals(doc, setInstanceVisible(doc, 'a', false))).toBe(false)
  })

  // Mirrors the page's mutate funnel (AssemblyEditor.tsx): same reference fast
  // path, then the structural compare, then the step recording. A same-value
  // toggle must clear none of the redo branch, set no dirty flag and push no
  // entry.
  it('a same-value visibility toggle through the funnel pushes nothing, stays clean and keeps redo', () => {
    const docA = docWith(['a'])
    const docRef = { current: docA }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    // Fill the redo branch so a dead push would visibly clear it.
    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)
    useUnsavedChangesStore.getState().setDirty(false)

    const funnelMutate = (label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const current = docRef.current!
      const next = fn(current)
      if (next === current || assemblyDocEquals(current, next)) return
      result.current.pushUndo(current, label)
      docRef.current = next
      setDoc(next)
      useUnsavedChangesStore.getState().setDirty(true)
    }

    act(() => { funnelMutate('Toggle visibility', d => setInstanceVisible(d, 'a', true)) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    // The dead toggle left the doc untouched: it is the snapshot undo restored,
    // equal to docA but not the original object (entries hold clones).
    expect(docRef.current).toEqual(docA)

    // A real flip still records its step and clears the redo branch.
    act(() => { funnelMutate('Toggle visibility', d => setInstanceVisible(d, 'a', false)) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  // A mate/instance editor that is edited and then typed back to its start
  // state leaves `pending` pinned (from the first keystroke); commitSession must
  // drop the entry because the pre-session doc and the current doc are equal.
  it('a session typed back to its start commits no entry', () => {
    const docA = docWith(['a'])
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.recordSessionEdit(docA, 'Set position') })
    // The edit applies, then is typed back to the start value.
    docRef.current = setInstancePosition(docA, 'a', { tx: 5, ty: 0, tz: 0 })
    docRef.current = setInstancePosition(docRef.current, 'a', { tx: 0, ty: 0, tz: 0 })

    act(() => { result.current.commitSession() })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)

    // The drop must not poison the next, real session.
    act(() => { result.current.recordSessionEdit(docRef.current!, 'Set position') })
    docRef.current = setInstancePosition(docRef.current, 'a', { tx: 7, ty: 0, tz: 0 })
    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(1)
  })

  // The part hook no-ops on a non-empty stack with no live doc; the assembly
  // hook must keep the paired stacks intact instead of dropping the entry and
  // overwriting docRef unconditionally.
  it('undo with a null docRef is a no-op that keeps the stacks paired', () => {
    const docA = docWith(['a'])
    const docRef = { current: null as AssemblyDoc | null }
    const setDoc = vi.fn()
    const requestSolve = vi.fn()
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, requestSolve,
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })

    expect(setDoc).not.toHaveBeenCalled()
    expect(requestSolve).not.toHaveBeenCalled()
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('redo restores the exact departing doc and never shares the stack entry', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    // The departing doc is parked as a snapshot, never by reference: mutating
    // the doc the test still holds must not rewrite what redo would restore.
    expect(result.current.redoStack[0].doc).toEqual(docB)
    expect(result.current.redoStack[0].doc).not.toBe(docB)

    docB.features!.push({ id: 'x', kind: 'part_instance', instance: {
      handle: 'x', doc_id: 'd-x', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
    } })

    act(() => { result.current.handleRedo() })
    // The redo restores the exact departing doc, pre-mutation.
    expect(docRef.current).toEqual(docWith(['a', 'b']))
    // The pre-redo doc became the undo counterpart, also a snapshot.
    expect(result.current.undoStack[0].doc).toEqual(docA)

    // An in-place mutation of the restored doc must not corrupt that parked entry.
    docRef.current!.features!.push({ id: 'y', kind: 'part_instance', instance: {
      handle: 'y', doc_id: 'd-y', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
    } })
    expect(result.current.undoStack[0].doc).toEqual(docA)
  })

  // The counterpart push on every undo/redo is capped too, so repeated
  // round-tripping can never grow a stack past the depth.
  it('round-trips repeatedly without either stack exceeding the depth', () => {
    const docRef = { current: docWith(['a']) }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    for (let i = 0; i < 8; i++) {
      act(() => { result.current.pushUndo(docWith([`f${i}`]), `op ${i}` as AssemblyUndoLabel) })
    }
    // Only the newest 3 of the 8 pushes survive the cap.
    expect(result.current.undoStack).toHaveLength(3)

    for (let i = 0; i < 8; i++) act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(3)
    expect(result.current.undoStack.length + result.current.redoStack.length)
      .toBeLessThanOrEqual(MAX_UNDO_DEPTH)

    for (let i = 0; i < 8; i++) act(() => { result.current.handleRedo() })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(3)
    expect(result.current.undoStack.length + result.current.redoStack.length)
      .toBeLessThanOrEqual(MAX_UNDO_DEPTH)

    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) act(() => { result.current.handleUndo() })
      for (let j = 0; j < 3; j++) act(() => { result.current.handleRedo() })
      expect(result.current.undoStack.length).toBeLessThanOrEqual(3)
      expect(result.current.redoStack.length).toBeLessThanOrEqual(3)
      // The conservation invariant that makes the counterpart cap unnecessary:
      // a move shifts exactly one entry across, so the sum never grows.
      expect(result.current.undoStack.length + result.current.redoStack.length)
        .toBeLessThanOrEqual(MAX_UNDO_DEPTH)
    }
  })

  // The whole-doc stringify this compare replaced was key-order sensitive: a
  // structurally identical doc whose keys were inserted in another order read as
  // a change and charged a dead undo entry. Two docs that differ only in key
  // order are the same document.
  it('assemblyDocEquals ignores object key order but catches a real change', () => {
    const a = mateDoc()
    const reordered: AssemblyDoc = {
      features: a.features!.map(f => ({ mate: f.mate, id: f.id, kind: f.kind })),
      kind: 'assembly',
    }
    expect(assemblyDocEquals(a, reordered)).toBe(true)
    expect(assemblyDocEquals(a, {
      ...reordered,
      features: [{ ...reordered.features![0], id: 'm2' }],
    })).toBe(false)
  })

  // The cleared-label no-op is the concrete case the touch-slice compare exists
  // for: setting a label then clearing it rebuilds the mate feature with its
  // keys in a different order, which the old stringify read as a change.
  it('a mate label set and cleared back through the funnel charges no dead entry', () => {
    const docA = mateDoc()
    const docRef = { current: docA }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    // Fill the redo branch so a dead push would visibly clear it.
    act(() => { result.current.pushUndo(docA, 'Add mate') })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)
    useUnsavedChangesStore.getState().setDirty(false)

    const funnelMutate = (label: AssemblyUndoLabel, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      const current = docRef.current!
      const next = fn(current)
      if (next === current || assemblyDocEquals(current, next)) return
      result.current.pushUndo(current, label)
      docRef.current = next
      setDoc(next)
      useUnsavedChangesStore.getState().setDirty(true)
    }

    act(() => {
      funnelMutate('Rename mate', d => {
        const named = setMateLabel(d, 'm1', 'Fixed 1')
        const cleared = setMateLabel(named, 'm1', '')
        // Rebuild the feature with its keys in another order: structurally
        // identical to docA, but not by the old stringify.
        return { ...cleared, features: (cleared.features ?? []).map(f => ({ mate: f.mate, id: f.id, kind: f.kind })) }
      })
    })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(docRef.current).toEqual(docA)
  })
})

function mateDoc(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [{
      id: 'm1',
      kind: 'mate',
      mate: {
        kind: 'fixed',
        label: 'Fixed 1',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'b1' },
      },
    }],
  }
}
