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
})
