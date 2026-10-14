// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest'
import {
  publishProbeCamera, publishProbeCanvas, publishProbeSketchPlane,
  replaceProbeSource, clearProbeSource, getSceneProbe, probeHitTest,
  getSceneProbeRevision, resetSceneProbeStore,
} from '../sceneProbeStore'
import type { ProbeCamera, ProbePickableSource } from '../sceneProbe'
import { SKETCH_VERTEX_LAYER_NAME } from '../layerNames'

/**
 * The store is what makes "published on change, not per frame" true: an equal
 * publish is a no-op, so a driver that polls every frame still only records
 * actual changes. The JSON round-trip pins the dev-bridge contract.
 */

// Maps world x in [-400, 400], y in [-300, 300] onto the 800x600 canvas.
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

const VERTEX_SOURCE: ProbePickableSource = {
  pickKey: 'vertex:F1:e1:start',
  entityKey: 'vertex:F1:e1:start',
  layer: SKETCH_VERTEX_LAYER_NAME,
  kind: 'point',
  points: [[0, 0, 0]],
}

beforeEach(() => {
  resetSceneProbeStore()
})

describe('scene probe store publishing', () => {
  it('starts empty with a zero revision', () => {
    const probe = getSceneProbe()
    expect(probe).toEqual({
      revision: 0,
      camera: null,
      canvas: { width: 0, height: 0 },
      sketchPlane: null,
      pickables: [],
    })
    expect(getSceneProbeRevision()).toBe(0)
  })

  it('bumps the revision once for a changed camera and not for an equal one', () => {
    publishProbeCamera(CAMERA)
    expect(getSceneProbeRevision()).toBe(1)
    publishProbeCamera({ ...CAMERA })
    expect(getSceneProbeRevision()).toBe(1)
    publishProbeCamera({ ...CAMERA, zoom: 2 })
    expect(getSceneProbeRevision()).toBe(2)
    expect(getSceneProbe().camera?.zoom).toBe(2)
  })

  it('bumps the revision once for a changed canvas and not for an equal one', () => {
    publishProbeCanvas(800, 600)
    expect(getSceneProbeRevision()).toBe(1)
    expect(getSceneProbe().canvas).toEqual({ width: 800, height: 600 })
    publishProbeCanvas(800, 600)
    expect(getSceneProbeRevision()).toBe(1)
    publishProbeCanvas(1024, 768)
    expect(getSceneProbeRevision()).toBe(2)
  })

  it('bumps the revision once for a changed sketch plane and not for an equal one', () => {
    const plane = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] }
    publishProbeSketchPlane(plane)
    expect(getSceneProbeRevision()).toBe(1)
    publishProbeSketchPlane({ ...plane, origin: [0, 0, 0] })
    expect(getSceneProbeRevision()).toBe(1)
    publishProbeSketchPlane(null)
    expect(getSceneProbeRevision()).toBe(2)
    expect(getSceneProbe().sketchPlane).toBeNull()
  })

  it('projects a registered source through the published camera and removes it', () => {
    publishProbeCamera(CAMERA)
    publishProbeCanvas(800, 600)
    replaceProbeSource('sketch:F1', [VERTEX_SOURCE])
    const probe = getSceneProbe()
    expect(probe.pickables).toEqual([{
      pickKey: 'vertex:F1:e1:start',
      entityKey: 'vertex:F1:e1:start',
      layer: SKETCH_VERTEX_LAYER_NAME,
      kind: 'point',
      screenPoints: [[400, 300]],
    }])
    expect(probeHitTest(400, 300).map(h => h.pickKey)).toEqual(['vertex:F1:e1:start'])

    clearProbeSource('sketch:F1')
    expect(getSceneProbe().pickables).toEqual([])
  })

  it('keeps pickables with no screen marks when no camera is published', () => {
    publishProbeCanvas(800, 600)
    replaceProbeSource('sketch:F1', [VERTEX_SOURCE])
    expect(getSceneProbe().pickables[0].screenPoints).toEqual([])
    expect(probeHitTest(400, 300)).toEqual([])
  })

  it('returns JSON-safe data that survives a round trip', () => {
    publishProbeCamera(CAMERA)
    publishProbeCanvas(800, 600)
    publishProbeSketchPlane({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [1, 2, 3] })
    replaceProbeSource('sketch:F1', [VERTEX_SOURCE])
    const probe = getSceneProbe()
    expect(JSON.parse(JSON.stringify(probe))).toEqual(probe)
  })

  it('keeps the revision stable while only reading', () => {
    publishProbeCamera(CAMERA)
    replaceProbeSource('sketch:F1', [VERTEX_SOURCE])
    getSceneProbe()
    probeHitTest(400, 300)
    getSceneProbe()
    expect(getSceneProbeRevision()).toBe(2)
  })
})
