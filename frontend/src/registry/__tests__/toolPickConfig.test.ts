import { describe, it, expect } from 'vitest'
import {
  getToolPickConfig, getToolAllowedLayers, effectiveAllowedLayers,
  SKETCH_DRAW_EXCLUDED, PROJECT_EXCLUDED, DIMENSION_EXCLUDED,
} from '../toolPickConfig'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, PART_EDITOR_PICK_LAYER_NAMES,
} from '@/picking/layerNames'

describe('getToolAllowedLayers', () => {
  it('allows all layers under null (idle select) / drag / offset', () => {
    expect(getToolAllowedLayers(null)).toBeNull()
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

  it('drops only the document planes under the dimension tool so a click over one places the dimension', () => {
    const allowed = getToolAllowedLayers('dimension')!
    expect(allowed.has(PLANE_LAYER_NAME)).toBe(false)
    // Everything a dimension can target, or a label it can grab, stays pickable.
    for (const layer of [
      SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
      EDGE_LAYER_NAME, VERTEX_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
    ]) expect(allowed.has(layer), layer).toBe(true)
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

describe('part-editor pick-layer partition', () => {
  // L2: every filtered preset is the canonical pick-layer list minus an explicit
  // exclusion set, so a layer added to PART_EDITOR_PICK_LAYER_NAMES is pickable
  // under every tool until that tool deliberately excludes it.
  it('SKETCH_DRAW, PROJECT_PICK and DIMENSION_PICK partition the part-editor pick layers', () => {
    for (const [tool, excluded] of [
      ['line', SKETCH_DRAW_EXCLUDED],
      ['project', PROJECT_EXCLUDED],
      ['dimension', DIMENSION_EXCLUDED],
    ] as const) {
      const allowed = getToolAllowedLayers(tool)!
      const drop = new Set<string>(excluded)
      for (const name of PART_EDITOR_PICK_LAYER_NAMES) {
        expect(allowed.has(name), `${tool}:${name}`).toBe(!drop.has(name))
      }
      for (const name of allowed) expect(PART_EDITOR_PICK_LAYER_NAMES).toContain(name)
    }
  })

  // A hard pin of today's membership so a future edit to an exclusion list is a
  // visible diff, not a silent behaviour change.
  it('pins the exact allowed membership per filtered tool', () => {
    expect([...getToolAllowedLayers('line')!].sort()).toEqual(
      [PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME].sort(),
    )
    expect([...getToolAllowedLayers('project')!].sort()).toEqual(
      [
        FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
        PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
      ].sort(),
    )
  })

  it('excludes sketchSurface and featureHandle from both filtered presets', () => {
    for (const tool of ['line', 'project'] as const) {
      expect(getToolAllowedLayers(tool)!.has(SKETCH_SURFACE_LAYER_NAME)).toBe(false)
      expect(getToolAllowedLayers(tool)!.has(FEATURE_HANDLE_LAYER_NAME)).toBe(false)
    }
  })
})

describe('effectiveAllowedLayers', () => {
  // L3: the single place `consumed ∩ toolAllowed` is composed.
  it('intersects the consumed set with the tool filter', () => {
    const consumed = new Set([FACE_LAYER_NAME, PLANE_LAYER_NAME])
    // null filter -> consumed returned by identity
    expect(effectiveAllowedLayers(consumed, null)).toBe(consumed)
    expect(effectiveAllowedLayers(consumed, 'drag')).toBe(consumed)
    // drawing tool -> B-rep filtered out
    expect([...effectiveAllowedLayers(consumed, 'line')]).toEqual([PLANE_LAYER_NAME])
    // nothing survives
    expect(effectiveAllowedLayers(new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME]), 'line').size).toBe(0)
    // project keeps B-rep
    expect(effectiveAllowedLayers(consumed, 'project').has(FACE_LAYER_NAME)).toBe(true)
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

describe('getToolPickConfig.staysArmedAfterCommit', () => {
  it('is true for every SKETCH_DRAW tool', () => {
    const drawTools = ['line', 'rect', 'center_rect', 'circle', 'arc', 'ellipse',
      'spline', 'point', 'ngon', 'mirror'] as const
    for (const t of drawTools) {
      expect(getToolPickConfig(t).staysArmedAfterCommit, t).toBe(true)
    }
  })

  it('is true for dimension and project', () => {
    expect(getToolPickConfig('dimension').staysArmedAfterCommit).toBe(true)
    expect(getToolPickConfig('project').staysArmedAfterCommit).toBe(true)
  })

  it('is false for drag, offset and idle select (null)', () => {
    expect(getToolPickConfig('drag').staysArmedAfterCommit).toBe(false)
    expect(getToolPickConfig('offset').staysArmedAfterCommit).toBe(false)
    expect(getToolPickConfig(null).staysArmedAfterCommit).toBe(false)
  })
})
