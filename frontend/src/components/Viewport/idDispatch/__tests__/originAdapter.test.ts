import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { originAdapter, clearOriginHover } from '../originAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredEntityId: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    normalSelection: new Set(),
  })
})

describe('originAdapter', () => {
  it('onHover sets hoveredEntityId and hoveredVertexId', () => {
    originAdapter.onHover('@builtin_origin')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredEntityId).toBe('@builtin_origin')
    expect(s.hoveredVertexId).toBe('@builtin_origin')
    expect(s.hoveredSnapKind).toBe('vertex')
  })

  it('clearOriginHover clears both hover fields', () => {
    originAdapter.onHover('@builtin_origin')
    clearOriginHover()
    const s = useSketchEditorStore.getState()
    expect(s.hoveredEntityId).toBeNull()
    expect(s.hoveredVertexId).toBeNull()
  })

  it('onClick toggles normalSelection', () => {
    originAdapter.onClick('@builtin_origin')
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_origin')).toBe(true)
  })
})
