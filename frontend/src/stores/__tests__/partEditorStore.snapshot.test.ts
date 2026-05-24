import { describe, it, expect, beforeEach } from 'vitest'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'

const OWNED_FIELDS = ['rollbackPosition', 'pickBoundary', 'editingFeatureId'] as const

describe('partEditorStore snapshot contract', () => {
  beforeEach(() => {
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    const s = usePartEditorStore.getState()
    s.setRollbackPosition(null)
    s.setPickBoundary(null)
    s.setEditingFeatureId(null)
  })

  it('setSnapshot replaces mirrored fields but preserves owned fields', () => {
    usePartEditorStore.getState().setEditingFeatureId('owned')
    usePartEditorStore.getState().setRollbackPosition(99)
    usePartEditorStore.getState().setSnapshot({
      ...DEFAULT_PART_EDITOR_DATA,
      features: [{ id: 'f1', kind: 'sketch' }],
      // These owned-field values in the snapshot are ignored.
      rollbackPosition: 2,
      editingFeatureId: 'f1',
    })
    const state = usePartEditorStore.getState()
    expect(state.features[0].id).toBe('f1')
    // Owned fields kept their setter-applied values.
    expect(state.rollbackPosition).toBe(99)
    expect(state.editingFeatureId).toBe('owned')
  })

  it('owned fields are mutated via dedicated setters only', () => {
    const s = usePartEditorStore.getState()
    s.setRollbackPosition(5)
    s.setPickBoundary(3)
    s.setEditingFeatureId('feat')
    const after = usePartEditorStore.getState()
    expect(after.rollbackPosition).toBe(5)
    expect(after.pickBoundary).toBe(3)
    expect(after.editingFeatureId).toBe('feat')
  })

  it('reset via DEFAULT_PART_EDITOR_DATA clears mirrored fields and leaves owned fields alone', () => {
    usePartEditorStore.getState().setEditingFeatureId('keep')
    usePartEditorStore.getState().setSnapshot({
      ...DEFAULT_PART_EDITOR_DATA,
      features: [{ id: 'f1', kind: 'sketch' }],
      validation: { passed: true, level: 1, diffs: {} },
    })
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    const state = usePartEditorStore.getState()
    expect(state.features).toEqual([])
    expect(state.validation).toBeNull()
    expect(state.editingFeatureId).toBe('keep')  // owned, preserved
  })

  it('field list in DEFAULT_PART_EDITOR_DATA matches field list after setSnapshot', () => {
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    const ignoredKeys = new Set<string>(['setSnapshot', 'setActiveSketchFeatureId', ...OWNED_FIELDS.map(f => `set${f[0].toUpperCase()}${f.slice(1)}`)])
    const afterReset = Object.keys(usePartEditorStore.getState()).filter(k => !ignoredKeys.has(k)).sort()
    const defaultKeys = Object.keys(DEFAULT_PART_EDITOR_DATA).sort()
    expect(afterReset).toEqual(defaultKeys)
  })
})
