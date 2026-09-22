import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildSketchVertices } from '@/picking/sketchIdBuilders'
import { suppressedCoincidentVertexIds } from '@/components/Geometry3D/dragLogic'
import type { Sketch, LineSegment } from '@/types/cad'

// Two line segments meeting at a corner joined by a coincident constraint must
// register one pickable vertex at that corner, not two stacked ids -- otherwise
// hover/select races between the partner the render layer hid and the one it
// drew. The merge is constraint-backed: drop the coincident and both return.
const identity = new THREE.Matrix4()

const cornerSketch = (): Sketch => ({
  lineA: { start: [0, 0], end: [2, 0] } as LineSegment,
  lineB: { start: [2, 0], end: [2, 2] } as LineSegment,
})

describe('useSketchIdRegistration coincident dedup', () => {
  it('registers a single corner vertex when a coincident constraint bonds them', () => {
    const suppressed = suppressedCoincidentVertexIds(
      [{ kind: 'coincident', a: '$lineAend', b: '$lineBstart' }], 'S1')
    const vtx = buildSketchVertices('S1', cornerSketch(), identity, suppressed)

    // lineA:end is the kept leader; lineB:start (the larger id) is hidden.
    expect(vtx.vertexQueries).toContain('vertex:S1:lineA:end')
    expect(vtx.vertexQueries).not.toContain('vertex:S1:lineB:start')
    // The other free endpoints stay pickable.
    expect(vtx.vertexQueries).toContain('vertex:S1:lineA:start')
    expect(vtx.vertexQueries).toContain('vertex:S1:lineB:end')
  })

  it('registers both corner vertices when the points merely overlap (no constraint)', () => {
    const vtx = buildSketchVertices('S1', cornerSketch(), identity, suppressedCoincidentVertexIds([], 'S1'))
    expect(vtx.vertexQueries).toContain('vertex:S1:lineA:end')
    expect(vtx.vertexQueries).toContain('vertex:S1:lineB:start')
  })

  it('skips a vertex whose 2D coordinate is non-finite', () => {
    // A NaN corner would bucket at the origin in the mark index and answer every
    // click near it, so it must never become a pickable vertex.
    const vtx = buildSketchVertices('S1', {
      lineA: { start: [NaN, 0], end: [2, 0] } as LineSegment,
    }, identity)

    expect(vtx.vertexQueries).toEqual(['vertex:S1:lineA:end'])
    expect(vtx.vertices).toHaveLength(1)
  })
})
