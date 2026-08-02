// The undo/redo stacks reach the PartToolbar through the store: Part passes the
// hook's stacks to useSyncPartEditorStore, which mirrors them (plus the rest of
// the editor data) into partEditorStore, which PartToolbar reads. Seeding the
// store directly in a toolbar test would miss a desync in this mirror, so the
// mirror gets its own suite.
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSyncPartEditorStore } from '@/hooks/useSyncPartEditorStore'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA, type PartEditorData } from '@/stores/partEditorStore'
import type { Mutation } from '@/types/cad'

const mutation = { type: 'add_sketch', featureId: 'sk1' } as Mutation

// What setSnapshot is supposed to write: DEFAULT minus the three store-owned
// fields (the mirror never passes them) with the stacks overridden.
type MirroredData = Omit<PartEditorData, 'rollbackPosition' | 'pickBoundary' | 'editingFeatureId'>

function mirroredData(overrides: Partial<MirroredData> = {}): MirroredData {
  const { rollbackPosition: _rollbackPosition, pickBoundary: _pickBoundary, editingFeatureId: _editingFeatureId, ...rest } = DEFAULT_PART_EDITOR_DATA
  return { ...rest, ...overrides }
}

describe('useSyncPartEditorStore', () => {
  it('mirrors the undo and redo stacks into the store the toolbar reads', () => {
    const undoEntry = { doc: { version: 1, kind: 'part' }, mutation }
    const redoEntry = { doc: { version: 1, kind: 'part' }, mutation }

    renderHook(() => useSyncPartEditorStore(
      mirroredData({ undoStack: [undoEntry], redoStack: [redoEntry] }),
    ))

    const store = usePartEditorStore.getState()
    expect(store.undoStack).toEqual([undoEntry])
    expect(store.redoStack).toEqual([redoEntry])
  })

  it('preserves the store-owned fields when the snapshot lands', () => {
    usePartEditorStore.getState().setEditingFeatureId('sk1')
    usePartEditorStore.getState().setRollbackPosition(2)
    usePartEditorStore.getState().setPickBoundary(1)

    renderHook(() => useSyncPartEditorStore(mirroredData()))

    // setSnapshot must not clobber the fields the store owns through setters.
    const store = usePartEditorStore.getState()
    expect(store.editingFeatureId).toBe('sk1')
    expect(store.rollbackPosition).toBe(2)
    expect(store.pickBoundary).toBe(1)
  })

  it('resets the mirrored stacks on unmount', () => {
    const undoEntry = { doc: { version: 1, kind: 'part' }, mutation }
    const { unmount } = renderHook(() => useSyncPartEditorStore(
      mirroredData({ undoStack: [undoEntry], redoStack: [undoEntry] }),
    ))
    expect(usePartEditorStore.getState().undoStack).toHaveLength(1)

    act(() => { unmount() })

    expect(usePartEditorStore.getState().undoStack).toEqual(DEFAULT_PART_EDITOR_DATA.undoStack)
    expect(usePartEditorStore.getState().redoStack).toEqual(DEFAULT_PART_EDITOR_DATA.redoStack)
  })
})
