import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { sketchEntityAdapter, clearSketchEntityHover } from '../sketchEntityAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    internalHoverSelection: null,
    hoveredEntityId: null,
  })
})

describe('sketchEntityAdapter', () => {
  it('onHover sets internalHoverSelection and hoveredEntityId', () => {
    sketchEntityAdapter.onHover('entity:feat1:line1')
    const s = useSketchEditorStore.getState()
    expect(s.internalHoverSelection).toBe('entity:feat1:line1')
    expect(s.hoveredEntityId).toBe('entity:feat1:line1')
  })

  it('clearSketchEntityHover clears both fields', () => {
    sketchEntityAdapter.onHover('entity:feat1:arc1')
    clearSketchEntityHover()
    const s = useSketchEditorStore.getState()
    expect(s.internalHoverSelection).toBeNull()
    expect(s.hoveredEntityId).toBeNull()
  })
})
