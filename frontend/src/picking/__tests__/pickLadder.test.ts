// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { IdPipeline } from '../IdPipeline'
import {
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
  PICK_LADDER, PICK_LAYER_PRIORITIES, pickPriorityOf,
} from '../layerNames'

/**
 * The ladder is exported as data so the scene probe can rank its candidates by
 * the same numbers the pipeline mounts. These tests are the "two readers" of
 * that one source: the literal pin below fails the moment a rung moves, and the
 * pipeline comparison fails if the constructor stops reading the data.
 */

describe('pick ladder as data', () => {
  it('pins every rung name and priority as literals', () => {
    expect(PICK_LADDER).toEqual([
      { name: PLANE_LAYER_NAME, priority: -10 },
      { name: FACE_LAYER_NAME, priority: 0 },
      { name: EDGE_LAYER_NAME, priority: 10 },
      { name: VERTEX_LAYER_NAME, priority: 20 },
      { name: SKETCH_SURFACE_LAYER_NAME, priority: 30 },
      { name: SKETCH_ENTITY_LAYER_NAME, priority: 40 },
      { name: ORIGIN_LAYER_NAME, priority: 45 },
      { name: SKETCH_VERTEX_LAYER_NAME, priority: 50 },
      { name: DIMENSION_LABEL_LAYER_NAME, priority: 70 },
      { name: FEATURE_HANDLE_LAYER_NAME, priority: 80 },
      { name: GIZMO_HANDLE_LAYER_NAME, priority: 90 },
    ])
  })

  it('mounts the pipeline at exactly the ladder data priorities', () => {
    const mounted = new IdPipeline({ width: 8, height: 8 }).getLayerPriority()
    const fromData = Object.fromEntries(PICK_LADDER.map(rung => [rung.name, rung.priority]))
    expect(mounted).toEqual(fromData)
  })

  it('derives the priority map from the ladder and falls back to 0', () => {
    expect(PICK_LAYER_PRIORITIES[ORIGIN_LAYER_NAME]).toBe(45)
    expect(Object.keys(PICK_LAYER_PRIORITIES)).toHaveLength(PICK_LADDER.length)
    // 0 is the resolver's own missing-layer fallback, so the probe matches it.
    expect(pickPriorityOf('not-a-layer')).toBe(0)
  })
})
