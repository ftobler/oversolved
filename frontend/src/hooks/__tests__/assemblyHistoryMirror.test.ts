import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { assemblyHistory } from '@/stores/assemblyHistory'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

// assemblyStore.undoStack/redoStack are the History's read mirror, not a second
// engine: every push, move and clear republishes them. These rows prove the
// mirror the toolbar reads equals the History the engine writes, so the two
// cannot drift while a drag or a coalescing session is in flight.

function resetStore() {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.getState().clearAssemblyHistory()
  useAssemblyStore.setState({
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

function expectMirrorMatchesHistory() {
  const { undoStack, redoStack } = useAssemblyStore.getState()
  expect(undoStack).toEqual(assemblyHistory.undoEntries())
  expect(redoStack).toEqual(assemblyHistory.redoEntries())
}

describe('assembly history mirror', () => {
  beforeEach(resetStore)

  it('mirrors push, undo and redo in step with the engine History', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    expect(result.current.undoStack).toHaveLength(1)
    expectMirrorMatchesHistory()

    act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    expectMirrorMatchesHistory()

    act(() => { result.current.handleRedo() })
    expect(result.current.redoStack).toHaveLength(0)
    expectMirrorMatchesHistory()
  })

  // A cancel rewinds the doc but pushes nothing, so the mirror must still show
  // exactly the pre-session History (the move-free path is the one a forgotten
  // publish would leave stale).
  it('keeps the mirror on the pre-session History across a cancel', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docA as AssemblyDoc | null }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    act(() => { result.current.mutate('Set position', () => docB) })
    act(() => { result.current.cancelSession() })

    expect(docRef.current).toEqual(docA)
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Add part'])
    expect(result.current.redoStack).toHaveLength(0)
    expectMirrorMatchesHistory()
  })

  // The commit path publishes one coalesced entry; the mirror must land with it
  // rather than staying on the empty pre-session view.
  it('mirrors the coalesced session entry on commit', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const docRef = { current: docA as AssemblyDoc | null }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    act(() => { result.current.mutate('Set position', () => docB) })
    act(() => { result.current.commitSession() })

    expect(result.current.undoStack.map(e => e.label)).toEqual(['Set position'])
    expectMirrorMatchesHistory()
  })

  // The module lifetime is the whole point of the singleton: a drag's pointer-up
  // commit can outlive the page's mount, so the stacks must survive a remount
  // and the new engine must be able to pop an entry the old one pushed.
  it('keeps the pushed entry across a remount, so the new engine still undoes it', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const firstRef = { current: docB as AssemblyDoc | null }
    const first = renderHookStrict(() => useAssemblyUndoRedo(
      firstRef as React.MutableRefObject<AssemblyDoc | null>,
      vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { firstRef.current = d as AssemblyDoc }),
      vi.fn(),
    ))
    act(() => { first.result.current.pushUndo(docA, 'Add part') })
    first.unmount()

    const secondRef = { current: docB as AssemblyDoc | null }
    const secondSet = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { secondRef.current = d as AssemblyDoc })
    const second = renderHookStrict(() => useAssemblyUndoRedo(
      secondRef as React.MutableRefObject<AssemblyDoc | null>, secondSet, vi.fn(),
    ))
    expect(second.result.current.undoStack).toHaveLength(1)

    act(() => { second.result.current.handleUndo() })

    expect(secondRef.current).toEqual(docA)
    expect(second.result.current.undoStack).toHaveLength(0)
    expect(second.result.current.redoStack).toHaveLength(1)
    expectMirrorMatchesHistory()
  })

  // The pin lives in the unmounted engine, so a remounted engine has nothing to
  // rewind. Its cancel must be a no-op that leaves the History (and the doc the
  // edit left behind) alone rather than reaching for a stale pre-session state.
  it('a cancel on a remounted engine with no pin leaves the stacks alone', () => {
    const docA = docWith(['a'])
    const docB = docWith(['a', 'b'])
    const firstRef = { current: docA as AssemblyDoc | null }
    const first = renderHookStrict(() => useAssemblyUndoRedo(
      firstRef as React.MutableRefObject<AssemblyDoc | null>,
      vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { firstRef.current = d as AssemblyDoc }),
      vi.fn(),
    ))
    act(() => { first.result.current.pushUndo(docA, 'Add part') })
    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    act(() => { first.result.current.mutate('Set position', () => docB) })
    first.unmount()

    const secondRef = { current: docB as AssemblyDoc | null }
    const secondSet = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { secondRef.current = d as AssemblyDoc })
    const second = renderHookStrict(() => useAssemblyUndoRedo(
      secondRef as React.MutableRefObject<AssemblyDoc | null>, secondSet, vi.fn(),
    ))
    act(() => { second.result.current.cancelSession() })

    expect(secondRef.current).toBe(docB)
    expect(secondSet).not.toHaveBeenCalled()
    expect(second.result.current.undoStack.map(e => e.label)).toEqual(['Add part'])
    expect(second.result.current.redoStack).toHaveLength(0)
    expectMirrorMatchesHistory()
  })
})
