import { describe, it, expect } from 'vitest'
import { getToolPickConfig, getToolAllowedLayers } from '../toolPickConfig'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
} from '@/picking/layerNames'
import type { ActiveTool } from '@/types/cad'

describe('getToolAllowedLayers', () => {
  it('allows all layers under null (idle select) / dimension / drag / offset', () => {
    expect(getToolAllowedLayers(null)).toBeNull()
    expect(getToolAllowedLayers('dimension')).toBeNull()
    expect(getToolAllowedLayers('drag')).toBeNull()
    expect(getToolAllowedLayers('offset')).toBeNull()
  })

  it('excludes dimensionLabel from drawing tools so clicks fall through to draw points', () => {
    const drawingTools = ['line', 'rect', 'center_rect', 'circle', 'arc', 'point', 'mirror'] as const
    for (const t of drawingTools) {
      const allowed = getToolAllowedLayers(t)
      expect(allowed).not.toBeNull()
      expect(allowed!.has(DIMENSION_LABEL_LAYER_NAME)).toBe(false)
    }
  })

  it('permits sketch / plane / origin picks under drawing tools but excludes B-rep', () => {
    const allowed = getToolAllowedLayers('line')!
    expect(allowed.has(PLANE_LAYER_NAME)).toBe(true)
    expect(allowed.has(SKETCH_ENTITY_LAYER_NAME)).toBe(true)
    expect(allowed.has(SKETCH_VERTEX_LAYER_NAME)).toBe(true)
    expect(allowed.has(ORIGIN_LAYER_NAME)).toBe(true)
    // B-rep stays out so a body face under the cursor is never selected mid-stroke.
    expect(allowed.has(FACE_LAYER_NAME)).toBe(false)
    expect(allowed.has(EDGE_LAYER_NAME)).toBe(false)
    expect(allowed.has(VERTEX_LAYER_NAME)).toBe(false)
  })

  it('adds B-rep layers under the project tool so 3D geometry can be projected', () => {
    const allowed = getToolAllowedLayers('project')!
    expect(allowed.has(FACE_LAYER_NAME)).toBe(true)
    expect(allowed.has(EDGE_LAYER_NAME)).toBe(true)
    expect(allowed.has(VERTEX_LAYER_NAME)).toBe(true)
    expect(allowed.has(PLANE_LAYER_NAME)).toBe(true)
    expect(allowed.has(SKETCH_ENTITY_LAYER_NAME)).toBe(true)
    expect(allowed.has(SKETCH_VERTEX_LAYER_NAME)).toBe(true)
    expect(allowed.has(ORIGIN_LAYER_NAME)).toBe(true)
  })
})

describe('getToolPickConfig.clearsSelectionOnEnter', () => {
  it('is true only for the dimension tool', () => {
    expect(getToolPickConfig('dimension').clearsSelectionOnEnter).toBe(true)
    expect(getToolPickConfig('line').clearsSelectionOnEnter).toBe(false)
    expect(getToolPickConfig('project').clearsSelectionOnEnter).toBe(false)
    expect(getToolPickConfig('drag').clearsSelectionOnEnter).toBe(false)
    expect(getToolPickConfig(null).clearsSelectionOnEnter).toBe(false)
  })
})

describe('getToolPickConfig is total', () => {
  it('returns a fully-formed config for every ActiveTool value', () => {
    // Runtime guard mirroring the compile-time exhaustiveness of the Record:
    // every tool resolves to a config with both fields defined.
    const tools: ActiveTool[] = [
      null, 'dimension', 'line', 'rect', 'center_rect', 'circle', 'arc',
      'ellipse', 'spline', 'point', 'ngon', 'project', 'drag', 'mirror', 'offset',
    ]
    for (const t of tools) {
      const cfg = getToolPickConfig(t)
      expect(cfg).toBeDefined()
      expect(typeof cfg.clearsSelectionOnEnter).toBe('boolean')
      expect(cfg.allowedLayers === null || cfg.allowedLayers instanceof Set).toBe(true)
    }
  })
})
