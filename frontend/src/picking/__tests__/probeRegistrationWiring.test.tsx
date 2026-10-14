// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Sketch } from '@/types/cad'
import {
  useSketchIdRegistration, useOriginMarkerIdRegistration,
  useDimensionLabelIdRegistration, useFeatureHandleIdRegistration,
} from '@/picking'
import { getSceneProbe, publishProbeCamera, publishProbeCanvas, resetSceneProbeStore } from '../sceneProbeStore'
import type { ProbeCamera } from '../sceneProbe'
import { setLivePipeline } from '../IdPipelineContext'
import { ORIGIN_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME } from '../layerNames'

/**
 * The registration hooks are the probe's publishers: they must report the same
 * builder output the ID layers consume, without requiring a live GL pipeline.
 * These tests render the hooks headless and read the projected probe store
 * directly.
 */

// Maps world x in [-400, 400] and y in [-300, 300] onto the 800x600 canvas.
const CAMERA: ProbeCamera = {
  position: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  zoom: 1,
  projectionMatrix: [
    1 / 400, 0, 0, 0,
    0, 1 / 300, 0, 0,
    0, 0, -1 / 500, 0,
    0, 0, 0, 1,
  ],
}

const sketch = { e1: { kind: 'line', start: [0, 0], end: [10, 0] } } as unknown as Sketch

function expectScreenPoints(actual: [number, number][], expected: [number, number][]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach(([ex, ey], i) => {
    expect(actual[i][0]).toBeCloseTo(ex, 9)
    expect(actual[i][1]).toBeCloseTo(ey, 9)
  })
}

beforeEach(() => {
  resetSceneProbeStore()
  setLivePipeline(null)
  publishProbeCamera(CAMERA)
  publishProbeCanvas(800, 600)
})

afterEach(() => {
  cleanup()
})

describe('probe publication from registration hooks', () => {
  it('publishes sketch entity polylines and vertices without a pipeline', () => {
    renderHook(() => useSketchIdRegistration({ featureId: 'F1', sketch }))
    const pickables = getSceneProbe().pickables
    expect(pickables.map(p => p.pickKey).sort()).toEqual([
      'entity:F1:e1', 'vertex:F1:e1:end', 'vertex:F1:e1:start',
    ])
    const entity = pickables.find(p => p.pickKey === 'entity:F1:e1')!
    expect(entity.layer).toBe(SKETCH_ENTITY_LAYER_NAME)
    expect(entity.kind).toBe('polyline')
    expectScreenPoints(entity.screenPoints, [[400, 300], [410, 300]])
    const vertex = pickables.find(p => p.pickKey === 'vertex:F1:e1:start')!
    expect(vertex.layer).toBe(SKETCH_VERTEX_LAYER_NAME)
    expect(vertex.kind).toBe('point')
    expectScreenPoints(vertex.screenPoints, [[400, 300]])
  })

  it('clears its source when the sketch hook unmounts', () => {
    const { unmount } = renderHook(() => useSketchIdRegistration({ featureId: 'F1', sketch }))
    expect(getSceneProbe().pickables.length).toBeGreaterThan(0)
    unmount()
    expect(getSceneProbe().pickables).toEqual([])
  })

  it('publishes the origin marker point', () => {
    renderHook(() => useOriginMarkerIdRegistration({ selectionId: '@builtin_origin' }))
    const pickables = getSceneProbe().pickables
    expect(pickables).toHaveLength(1)
    expect(pickables[0]).toMatchObject({
      pickKey: '@builtin_origin',
      entityKey: '@builtin_origin',
      layer: ORIGIN_LAYER_NAME,
      kind: 'point',
    })
    expectScreenPoints(pickables[0].screenPoints, [[400, 300]])
  })

  it('publishes a feature handle as its arrow segment', () => {
    renderHook(() => useFeatureHandleIdRegistration({
      featureId: 'F1', field: 'depth', start: [0, 0, 0], end: [0, 10, 0],
    }))
    const pickables = getSceneProbe().pickables
    expect(pickables).toHaveLength(1)
    expect(pickables[0]).toMatchObject({
      pickKey: 'fhandle:F1:depth',
      entityKey: 'fhandle:F1:depth',
      layer: FEATURE_HANDLE_LAYER_NAME,
      kind: 'polyline',
    })
    expectScreenPoints(pickables[0].screenPoints, [[400, 300], [400, 290]])
  })

  it('publishes a dimension label point through its plane transform', () => {
    renderHook(() => useDimensionLabelIdRegistration({
      constraintId: 'C1', position: [1, 2, 0],
      planeTransform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [10, 20, 30] },
    }))
    const pickables = getSceneProbe().pickables
    expect(pickables).toHaveLength(1)
    expect(pickables[0]).toMatchObject({
      pickKey: 'dim:C1',
      entityKey: 'dim:C1',
      layer: DIMENSION_LABEL_LAYER_NAME,
      kind: 'point',
    })
    expectScreenPoints(pickables[0].screenPoints, [[411, 278]])
  })
})
