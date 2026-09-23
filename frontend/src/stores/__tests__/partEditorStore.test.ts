import { describe, it, expect, beforeEach } from 'vitest'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'

describe('partEditorStore', () => {
  beforeEach(() => {
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
  })

  it('default state has empty features and null doc', () => {
    const state = usePartEditorStore.getState()
    expect(state.features).toEqual([])
    expect(state.doc).toBeNull()
    expect(state.rollbackPosition).toBeNull()
    expect(state.editingFeatureId).toBeNull()
  })

  it('setSnapshot replaces mirrored fields but preserves owned fields', () => {
    const { getState } = usePartEditorStore
    getState().setRollbackPosition(99)
    getState().setEditingFeatureId('owned')
    getState().setSnapshot({
      ...DEFAULT_PART_EDITOR_DATA,
      features: [{ id: 'f1', kind: 'extrude' }],
      doc: { version: 1, kind: 'part', features: [] },
      rollbackPosition: 1,
      editingFeatureId: 'f1',
      visibleFeatures: new Set(['f1']),
    })
    expect(getState().features).toHaveLength(1)
    expect(getState().features[0].id).toBe('f1')
    // Owned fields preserved from setter-applied values.
    expect(getState().rollbackPosition).toBe(99)
    expect(getState().editingFeatureId).toBe('owned')
    expect(getState().visibleFeatures.has('f1')).toBe(true)
  })
})
