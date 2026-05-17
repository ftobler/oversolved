import { describe, it, expect } from 'vitest'
import { getToolAllowedLayers } from '../toolAllowedLayers'
import { DIMENSION_LABEL_LAYER_NAME } from '@/picking'

describe('getToolAllowedLayers', () => {
  it('allows all layers under the select / dimension / drag tools (null)', () => {
    expect(getToolAllowedLayers(null)).toBeNull()
    expect(getToolAllowedLayers('select')).toBeNull()
    expect(getToolAllowedLayers('dimension')).toBeNull()
    expect(getToolAllowedLayers('drag')).toBeNull()
  })

  it('excludes dimensionLabel from drawing tools so clicks fall through to draw points', () => {
    const drawingTools = ['line', 'rect', 'center_rect', 'circle', 'arc', 'point', 'project', 'mirror'] as const
    for (const t of drawingTools) {
      const allowed = getToolAllowedLayers(t)
      expect(allowed).not.toBeNull()
      expect(allowed!.has(DIMENSION_LABEL_LAYER_NAME)).toBe(false)
    }
  })
})
