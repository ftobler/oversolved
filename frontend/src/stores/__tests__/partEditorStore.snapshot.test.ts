import { describe, it, expect, beforeEach } from 'vitest'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'

describe('partEditorStore snapshot contract', () => {
  beforeEach(() => {
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
  })

  it('setSnapshot replaces every field in DEFAULT_PART_EDITOR_DATA', () => {
    const patch = {
      ...DEFAULT_PART_EDITOR_DATA,
      features: [{ id: 'f1', kind: 'sketch' }],
      rollbackPosition: 2,
      editingFeatureId: 'f1',
    }
    usePartEditorStore.getState().setSnapshot(patch)
    const state = usePartEditorStore.getState()
    expect(state.features[0].id).toBe('f1')
    expect(state.rollbackPosition).toBe(2)
    expect(state.editingFeatureId).toBe('f1')
  })

  it('reset via DEFAULT_PART_EDITOR_DATA clears all data fields', () => {
    usePartEditorStore.getState().setSnapshot({
      ...DEFAULT_PART_EDITOR_DATA,
      features: [{ id: 'f1', kind: 'sketch' }],
      editingFeatureId: 'f1',
      validation: { passed: true, level: 1, diffs: {} },
    })
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    const state = usePartEditorStore.getState()
    expect(state.features).toEqual([])
    expect(state.editingFeatureId).toBeNull()
    expect(state.validation).toBeNull()
  })

  it('field list in DEFAULT_PART_EDITOR_DATA matches field list after setSnapshot', () => {
    usePartEditorStore.getState().setSnapshot(DEFAULT_PART_EDITOR_DATA)
    const afterReset = Object.keys(usePartEditorStore.getState()).filter(k => k !== 'setSnapshot' && k !== 'setActiveSketchFeatureId').sort()
    const defaultKeys = Object.keys(DEFAULT_PART_EDITOR_DATA).sort()
    expect(afterReset).toEqual(defaultKeys)
  })
})
