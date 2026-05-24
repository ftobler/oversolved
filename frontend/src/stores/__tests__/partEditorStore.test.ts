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

  it('sets individual fields via setState', () => {
    usePartEditorStore.setState({ isRebuilding: true })
    expect(usePartEditorStore.getState().isRebuilding).toBe(true)

    usePartEditorStore.setState({ isRebuilding: false })
    expect(usePartEditorStore.getState().isRebuilding).toBe(false)
  })

  it('sets features via setState', () => {
    const features = [{ id: 'f1', kind: 'sketch' }]
    usePartEditorStore.setState({ features })
    expect(usePartEditorStore.getState().features).toEqual(features)
  })

  it('sets doc via setState', () => {
    const doc = { version: 1, kind: 'part', features: [] }
    usePartEditorStore.setState({ doc })
    expect(usePartEditorStore.getState().doc).toBe(doc)
  })

  it('sets rollbackPosition via setRollbackPosition', () => {
    usePartEditorStore.getState().setRollbackPosition(3)
    expect(usePartEditorStore.getState().rollbackPosition).toBe(3)
  })

  it('sets editingFeatureId via setEditingFeatureId', () => {
    usePartEditorStore.getState().setEditingFeatureId('f2')
    expect(usePartEditorStore.getState().editingFeatureId).toBe('f2')
  })

  it('sets visibleFeatures via setState', () => {
    usePartEditorStore.setState({ visibleFeatures: new Set(['f1', 'f2']) })
    expect(usePartEditorStore.getState().visibleFeatures.has('f1')).toBe(true)
    expect(usePartEditorStore.getState().visibleFeatures.has('f2')).toBe(true)
  })

  it('sets bodies via setState', () => {
    const bodies = { body1: { id: 'body1', created_by: 'ex1', modified_by: [], mesh: { vertices: new Float32Array(), faces: new Uint32Array(), face_data: [], triangle_to_face: undefined, face_queries: [] }, edges: [], edge_queries: [], vertices: [], vertex_queries: [] } }
    usePartEditorStore.setState({ bodies })
    expect(usePartEditorStore.getState().bodies.body1.id).toBe('body1')
  })

  it('sets solveResults via setState', () => {
    usePartEditorStore.setState({ solveResults: { ex1: { success: true } } })
    expect(usePartEditorStore.getState().solveResults.ex1).toEqual({ success: true })
  })

  it('sets featureTimings via setState', () => {
    usePartEditorStore.setState({ featureTimings: { ex1: 42 } })
    expect(usePartEditorStore.getState().featureTimings.ex1).toBe(42)
  })
})
