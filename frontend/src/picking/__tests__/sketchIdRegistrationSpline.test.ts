import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildSketchSegments, buildSketchVertices } from '@/picking/sketchIdBuilders'
import type { Sketch, Spline } from '@/types/cad'

// Same hazard the ellipse work hit: without a spline arm in the ID-buffer
// registration the cubic Bezier has no pickable path and no pickable control
// vertices, so it can't be selected, dragged, or constrained.
const identity = new THREE.Matrix4()

const splineSketch = (): Sketch => ({
  s1: { p1: [0, 0], p2: [1, 3], p3: [3, 3], p4: [4, 0] } as Spline,
})

describe('useSketchIdRegistration spline', () => {
  it('registers the spline path as a pickable entity edge', () => {
    const seg = buildSketchSegments('S1', splineSketch(), identity)
    expect(seg.edgeQueries).toContain('entity:S1:s1')
    expect(seg.segmentPositions.length).toBeGreaterThan(0)
    const edgeIdx = seg.edgeQueries.indexOf('entity:S1:s1')
    expect([...seg.segmentToEdge].every(i => i === edgeIdx)).toBe(true)
  })

  it('registers start, end, and both control points as pickable vertices', () => {
    const vtx = buildSketchVertices('S1', splineSketch(), identity)
    for (const key of ['start', 'c1', 'c2', 'end']) {
      expect(vtx.vertexQueries).toContain(`vertex:S1:s1:${key}`)
    }
    // c1 (control point 1) sits at P2 = (1, 3) under the identity transform.
    const idx = vtx.vertexQueries.indexOf('vertex:S1:s1:c1')
    expect(vtx.vertices[idx][0]).toBeCloseTo(1)
    expect(vtx.vertices[idx][1]).toBeCloseTo(3)
  })
})
