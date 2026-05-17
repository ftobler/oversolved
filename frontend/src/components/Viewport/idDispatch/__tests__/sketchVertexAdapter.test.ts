import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sketchVertexAdapter, clearSketchVertexHover } from '../sketchVertexAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
  })
})

describe('sketchVertexAdapter', () => {
  it('onHover sets hoveredVertexId and snapKind', () => {
    sketchVertexAdapter.onHover('vertex:feat1:line1:start')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexId).toBe('vertex:feat1:line1:start')
    expect(s.hoveredSnapKind).toBe('vertex')
  })

  it('clearSketchVertexHover clears all vertex hover fields', () => {
    sketchVertexAdapter.onHover('vertex:feat1:arc1:center')
    clearSketchVertexHover()
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexId).toBeNull()
    expect(s.hoveredVertexPosition).toBeNull()
    expect(s.hoveredSnapKind).toBeNull()
  })
})
