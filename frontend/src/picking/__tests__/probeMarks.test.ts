// @vitest-environment node

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import type { Sketch } from '@/types/cad'
import { buildSketchSegments, buildSketchVertices } from '../sketchIdBuilders'
import {
  polylinePickables, pointPickables, pointPickable, polylinePickable, polygonPickables,
} from '../probeMarks'
import { ORIGIN_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '../layerNames'

/**
 * Mark extraction must run off the same builder output the ID layers consume,
 * so the probe's polylines and points are the geometry the resolver's pixels
 * were drawn from, not a second tessellation that can drift.
 */

const identity = new THREE.Matrix4()

describe('probeMarks: sketch builders to pickables', () => {
  it('turns one line entity into one two-point polyline keyed by its query', () => {
    const sketch = { e1: { kind: 'line', start: [0, 0], end: [10, 0] } } as unknown as Sketch
    const seg = buildSketchSegments('F1', sketch, identity)
    const pickables = polylinePickables(SKETCH_ENTITY_LAYER_NAME, seg.edgeQueries, seg.segmentPositions, seg.segmentToEdge)

    expect(pickables).toHaveLength(1)
    expect(pickables[0].layer).toBe(SKETCH_ENTITY_LAYER_NAME)
    expect(pickables[0].kind).toBe('polyline')
    expect(pickables[0].pickKey).toBe('entity:F1:e1')
    expect(pickables[0].entityKey).toBe('entity:F1:e1')
    expect(pickables[0].points).toEqual([[0, 0, 0], [10, 0, 0]])
  })

  it('joins the sampled segments of a circle into one closed polyline', () => {
    const sketch = { c1: { kind: 'circle', center: [0, 0], radius: 5 } } as unknown as Sketch
    const seg = buildSketchSegments('F1', sketch, identity)
    const pickables = polylinePickables(SKETCH_ENTITY_LAYER_NAME, seg.edgeQueries, seg.segmentPositions, seg.segmentToEdge)

    expect(pickables).toHaveLength(1)
    expect(pickables[0].points).toHaveLength(65)  // 64 samples plus the repeated closing point
    expect(pickables[0].points[0][0]).toBeCloseTo(5, 12)
    expect(pickables[0].points[64][0]).toBeCloseTo(5, 12)
    expect(pickables[0].points[64][1]).toBeCloseTo(0, 12)
  })

  it('keeps entity order and skips a point entity that owns no segments', () => {
    const sketch = {
      e1: { kind: 'line', start: [0, 0], end: [1, 0] },
      p1: { kind: 'point', x: 2, y: 2 },
      e2: { kind: 'line', start: [3, 0], end: [4, 0] },
    } as unknown as Sketch
    const seg = buildSketchSegments('F1', sketch, identity)
    const pickables = polylinePickables(SKETCH_ENTITY_LAYER_NAME, seg.edgeQueries, seg.segmentPositions, seg.segmentToEdge)
    expect(pickables.map(p => p.pickKey)).toEqual(['entity:F1:e1', 'entity:F1:e2'])
  })

  it('turns sketch vertices (and inferred contacts appended to them) into point pickables', () => {
    const sketch = { e1: { kind: 'line', start: [0, 0], end: [10, 0] } } as unknown as Sketch
    const vtx = buildSketchVertices('F1', sketch, identity)
    const pickables = pointPickables(SKETCH_VERTEX_LAYER_NAME, vtx.vertices, vtx.vertexQueries)

    expect(pickables.map(p => p.pickKey)).toEqual([
      'vertex:F1:e1:start', 'vertex:F1:e1:end',
    ])
    expect(pickables[0].points).toEqual([[0, 0, 0]])
    expect(pickables[0].kind).toBe('point')
  })

  it('applies the plane transform to vertex world positions', () => {
    const sketch = { e1: { kind: 'line', start: [0, 0], end: [10, 0] } } as unknown as Sketch
    const m = new THREE.Matrix4().makeTranslation(100, 200, 300)
    const vtx = buildSketchVertices('F1', sketch, m)
    const pickables = pointPickables(SKETCH_VERTEX_LAYER_NAME, vtx.vertices, vtx.vertexQueries)
    expect(pickables[0].points).toEqual([[100, 200, 300]])
  })

  it('builds single point and segment pickables for the origin and feature handles', () => {
    expect(pointPickable(ORIGIN_LAYER_NAME, '@builtin_origin', [0, 0, 0])).toEqual({
      pickKey: '@builtin_origin',
      entityKey: '@builtin_origin',
      layer: ORIGIN_LAYER_NAME,
      kind: 'point',
      points: [[0, 0, 0]],
    })
    expect(polylinePickable('featureHandle', 'fhandle:F1:depth', [[0, 0, 0], [0, 10, 0]]).kind)
      .toBe('polyline')
  })

  it('builds a closed-shape polygon per surface in the sketch plane frame', () => {
    const pickables = polygonPickables(
      'sketchSurface',
      [{ query: '?1;@a', outline: [[0, 0], [4, 0], [4, 4], [0, 4]] }],
      { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [10, 20, 30] },
    )
    expect(pickables).toEqual([{
      pickKey: '?1;@a',
      entityKey: '?1;@a',
      layer: 'sketchSurface',
      kind: 'polygon',
      points: [[10, 20, 30], [14, 20, 30], [14, 24, 30], [10, 24, 30]],
    }])
  })
})
