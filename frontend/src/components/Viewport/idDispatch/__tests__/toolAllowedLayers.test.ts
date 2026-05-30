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

  it('permits sketch / plane / origin picks under drawing tools but excludes B-rep', () => {
    const allowed = getToolAllowedLayers('line')!
    expect(allowed.has('planeFace')).toBe(true)
    expect(allowed.has('sketchEntity')).toBe(true)
    expect(allowed.has('sketchVertex')).toBe(true)
    expect(allowed.has('originMarker')).toBe(true)
    // B-rep stays out so a body face under the cursor is never selected mid-stroke.
    expect(allowed.has('face')).toBe(false)
    expect(allowed.has('edge')).toBe(false)
    expect(allowed.has('vertex')).toBe(false)
  })

  it('adds B-rep layers under the project tool so 3D geometry can be projected', () => {
    const allowed = getToolAllowedLayers('project')!
    expect(allowed.has('face')).toBe(true)
    expect(allowed.has('edge')).toBe(true)
    expect(allowed.has('vertex')).toBe(true)
    expect(allowed.has('planeFace')).toBe(true)
    expect(allowed.has('sketchEntity')).toBe(true)
    expect(allowed.has('sketchVertex')).toBe(true)
    expect(allowed.has('originMarker')).toBe(true)
  })
})
