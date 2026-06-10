// Body B-rep ellipse edges (full-brep-projection) render as a closed polyline.
// Guards the ellipse arms of buildEdgeSegments / getEdgeSegmentCounts that the
// circle/arc/spline arms previously did not cover.
import { describe, it, expect } from 'vitest'
import { buildEdgeSegments, getEdgeSegmentCounts } from '@/components/Geometry3D/bodyGeometry'
import type { EdgeData } from '@/types/cad'

describe('buildEdgeSegments ellipse', () => {
  const ellipse: EdgeData = {
    kind: 'ellipse',
    center: [1, 2, 0],
    a: 4,
    b: 2,
    axis: [0, 0, 1],
    x_axis: [1, 0, 0],
    angle_start: 0,
    angle_end: 2 * Math.PI,
  }

  it('emits one closed loop of ARC_SEGMENTS segments', () => {
    const segs = buildEdgeSegments([ellipse])
    const count = getEdgeSegmentCounts([ellipse])[0]
    // 6 floats per segment.
    expect(segs.length).toBe(count * 6)
    // First sample starts at center + a*x_axis (t=0).
    expect(segs[0]).toBeCloseTo(5)  // 1 + 4
    expect(segs[1]).toBeCloseTo(2)
    expect(segs[2]).toBeCloseTo(0)
  })

  it('renders only the parametric range for a partial elliptical arc', () => {
    // Quarter sweep [0, pi/2]: ~1/4 the segments of a full ellipse, and the
    // endpoints sit at the major (t=0) and minor (t=pi/2) axis points.
    const arc: EdgeData = { ...ellipse, angle_start: 0, angle_end: Math.PI / 2 }
    const segs = buildEdgeSegments([arc])
    const count = getEdgeSegmentCounts([arc])[0]
    expect(segs.length).toBe(count * 6)
    expect(count).toBeLessThan(getEdgeSegmentCounts([ellipse])[0])
    // Last point at t=pi/2: center + b*v = [1, 2+2, 0].
    const n = segs.length
    expect(segs[n - 3]).toBeCloseTo(1)
    expect(segs[n - 2]).toBeCloseTo(4)
    expect(segs[n - 1]).toBeCloseTo(0)
  })

  it('every sampled point lies on the ellipse', () => {
    const segs = buildEdgeSegments([ellipse])
    for (let i = 0; i < segs.length; i += 3) {
      const dx = (segs[i] - 1) / 4
      const dy = (segs[i + 1] - 2) / 2
      expect(dx * dx + dy * dy).toBeCloseTo(1, 5)
      expect(segs[i + 2]).toBeCloseTo(0)  // planar in z=0
    }
  })

  it('closes back onto the start point', () => {
    const segs = buildEdgeSegments([ellipse])
    const n = segs.length
    expect(segs[n - 3]).toBeCloseTo(segs[0])
    expect(segs[n - 2]).toBeCloseTo(segs[1])
    expect(segs[n - 1]).toBeCloseTo(segs[2])
  })
})
