// buildEdgeSegmentGeometry must reject non-finite angles, not just NaN. With an
// Infinity angle the segment count became Infinity and the tessellation loop
// never terminated, freezing the whole viewport on one malformed edge.
import { describe, it, expect } from 'vitest'
import { buildEdgeSegmentGeometry } from '@/components/Geometry3D/bodyGeometry'
import type { EdgeData } from '@/types/cad'

describe('buildEdgeSegmentGeometry non-finite angles', () => {
  it('skips an arc whose start angle is Infinity instead of looping forever', () => {
    const arc: EdgeData = {
      kind: 'arc', center: [0, 0, 0], radius: 1, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: Infinity, angle_end: Math.PI,
    }
    expect(buildEdgeSegmentGeometry([arc]).edgeSegmentCounts).toEqual([0])
  })

  it('skips an arc whose end angle is Infinity', () => {
    const arc: EdgeData = {
      kind: 'arc', center: [0, 0, 0], radius: 1, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: 0, angle_end: -Infinity,
    }
    expect(buildEdgeSegmentGeometry([arc]).edgeSegmentCounts).toEqual([0])
  })

  it('skips an ellipse whose start angle is Infinity', () => {
    const ellipse: EdgeData = {
      kind: 'ellipse', center: [0, 0, 0], a: 2, b: 1, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: Infinity, angle_end: Math.PI,
    }
    expect(buildEdgeSegmentGeometry([ellipse]).edgeSegmentCounts).toEqual([0])
  })

  it('skips an ellipse whose end angle is Infinity', () => {
    const ellipse: EdgeData = {
      kind: 'ellipse', center: [0, 0, 0], a: 2, b: 1, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: 0, angle_end: Infinity,
    }
    expect(buildEdgeSegmentGeometry([ellipse]).edgeSegmentCounts).toEqual([0])
  })
})
