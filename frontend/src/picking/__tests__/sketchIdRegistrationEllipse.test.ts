import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildSketchSegments, buildSketchVertices } from '@/picking/useSketchIdRegistration'
import type { Sketch, Ellipse } from '@/types/cad'

// Regression: the ID-buffer registration only handled line/arc/circle/point, so
// an ellipse registered no pickable path and no center vertex -- you couldn't
// select the curve, select/drag the control point, or therefore constrain it.
const identity = new THREE.Matrix4()

const ellipseSketch = (): Sketch => ({
  e1: { center: [1, 2], a: 4, b: 2, theta: 30 } as Ellipse,
})

describe('useSketchIdRegistration ellipse', () => {
  it('registers the ellipse path as a pickable entity edge', () => {
    const seg = buildSketchSegments('S1', ellipseSketch(), identity)
    expect(seg.edgeQueries).toContain('entity:S1:e1')
    // The path is sampled into many pick segments (not zero).
    expect(seg.segmentPositions.length).toBeGreaterThan(0)
    expect(seg.segmentToEdge.length).toBeGreaterThan(0)
    // Every segment maps back to the ellipse's edge index.
    const edgeIdx = seg.edgeQueries.indexOf('entity:S1:e1')
    expect([...seg.segmentToEdge].every(i => i === edgeIdx)).toBe(true)
  })

  it('registers the ellipse center as a pickable/draggable control vertex', () => {
    const vtx = buildSketchVertices('S1', ellipseSketch(), identity)
    expect(vtx.vertexQueries).toContain('vertex:S1:e1:center')
    const idx = vtx.vertexQueries.indexOf('vertex:S1:e1:center')
    // identity plane transform -> center stays at (1, 2, 0).
    expect(vtx.vertices[idx][0]).toBeCloseTo(1)
    expect(vtx.vertices[idx][1]).toBeCloseTo(2)
  })

  it('registers the 4 axis control points as pickable vertices', () => {
    const vtx = buildSketchVertices('S1', ellipseSketch(), identity)
    for (const key of ['major1', 'major2', 'minor1', 'minor2']) {
      expect(vtx.vertexQueries).toContain(`vertex:S1:e1:${key}`)
    }
  })
})
