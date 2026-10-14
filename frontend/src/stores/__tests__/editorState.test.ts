import { describe, it, expect, beforeEach } from 'vitest'
import { editorState, DEFAULT_EDITOR_STATE, clampRollback } from '@/stores/editorState'
import type { PartDoc } from '@/types/cad'

function makeDoc(featureCount: number, rollback?: number): PartDoc {
  const doc: PartDoc = {
    version: 1,
    kind: 'part',
    features: Array.from({ length: featureCount }, (_, i) => ({ id: `f${i}`, kind: 'sketch' })),
  }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

beforeEach(() => {
  editorState.getState().resetEditorState()
})

describe('editorState part FSM', () => {
  it('owns rollbackPosition, pickBoundary and editingFeatureId through setters', () => {
    const store = editorState.getState()
    expect(store.rollbackPosition).toBe(DEFAULT_EDITOR_STATE.rollbackPosition)
    expect(store.pickBoundary).toBe(DEFAULT_EDITOR_STATE.pickBoundary)
    expect(store.editingFeatureId).toBe(DEFAULT_EDITOR_STATE.editingFeatureId)

    store.setRollbackPosition(5)
    store.setPickBoundary(3)
    store.setEditingFeatureId('feat')
    const after = editorState.getState()
    expect(after.rollbackPosition).toBe(5)
    expect(after.pickBoundary).toBe(3)
    expect(after.editingFeatureId).toBe('feat')
  })

  it('resetEditorState drops every field the store owns, leaving nothing behind', () => {
    const store = editorState.getState()
    store.setRollbackPosition(2)
    store.setPickBoundary(1)
    store.setEditingFeatureId('feat')
    store.setViewportDerived({ ghostMode: true, partColors: { b1: '#fff' }, partStyle: { b1: { color: '#fff' } } })
    store.setActiveSketchFeatureId('sk1')

    editorState.getState().resetEditorState()

    const after = editorState.getState()
    expect(after.rollbackPosition).toBeNull()
    expect(after.pickBoundary).toBeNull()
    expect(after.editingFeatureId).toBeNull()
    expect(after.ghostMode).toBe(false)
    expect(after.partColors).toEqual({})
    expect(after.partStyle).toEqual({})
    expect(after.activeSketchFeatureId).toBeNull()
  })
})

describe('clampRollback', () => {
  it('clamps a stale position to the restored feature list', () => {
    expect(clampRollback(makeDoc(3, 99))).toBe(3)
  })

  it('keeps an in-range parked position', () => {
    expect(clampRollback(makeDoc(3, 2))).toBe(2)
  })

  it('floors a negative position at zero', () => {
    expect(clampRollback(makeDoc(3, -3))).toBe(0)
  })

  it('defaults to the end of the stack when the doc parks nothing', () => {
    expect(clampRollback(makeDoc(3))).toBe(3)
    expect(clampRollback({ version: 1, kind: 'part', features: [] } as PartDoc)).toBe(0)
  })
})

describe('restoreHistory', () => {
  // Undo and redo both emit one restored doc through the same store action, so
  // one behavior table covers both directions.
  it('clamps the bar to the restored doc and clears the open editor', () => {
    const store = editorState.getState()
    store.setRollbackPosition(1)
    store.setEditingFeatureId('ex1')
    store.setPickBoundary(0)

    editorState.getState().restoreHistory(makeDoc(4, 2))

    const after = editorState.getState()
    expect(after.rollbackPosition).toBe(2)
    expect(after.editingFeatureId).toBeNull()
    expect(after.pickBoundary).toBeNull()
  })

  it('falls back to the end of the restored feature list when it parks nothing', () => {
    editorState.getState().setRollbackPosition(9)

    editorState.getState().restoreHistory(makeDoc(2))

    expect(editorState.getState().rollbackPosition).toBe(2)
  })
})
