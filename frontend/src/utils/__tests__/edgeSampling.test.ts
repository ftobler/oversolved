import { describe, it, expect } from 'vitest'
import type { EdgeCurve } from '@/kernel/partBundle'
import {
  DEFAULT_CURVE_RESOLUTION,
  buildCurveSegments,
  buildIndexedCurveSegments,
  sampleEdgeCurve,
  segmentCount,
} from '@/utils/edgeSampling'

const line: EdgeCurve = {
  id: 'e_line',
  kind: 'line',
  point: [5, 0, 0],
  axis: [1, 0, 0],
  endpoints: [[0, 0, 0], [10, 0, 0]],
}

/** Radius 5 in the z=0 plane, swept from +X counterclockwise about +Z. */
const circle = (angle_start: number, angle_end: number): EdgeCurve => ({
  id: 'e_circle',
  kind: 'circle',
  point: [0, 0, 0],
  axis: [0, 0, 1],
  radius: 5,
  x_axis: [1, 0, 0],
  angle_start,
  angle_end,
  endpoints: [
    [5 * Math.cos(angle_start), 5 * Math.sin(angle_start), 0],
    [5 * Math.cos(angle_end), 5 * Math.sin(angle_end), 0],
  ],
})

const ellipse: EdgeCurve = {
  id: 'e_ellipse',
  kind: 'ellipse',
  point: [0, 0, 0],
  axis: [0, 0, 1],
  radius: 8,
  minor_radius: 3,
  x_axis: [1, 0, 0],
  angle_start: 0,
  angle_end: 2 * Math.PI,
  endpoints: [[8, 0, 0], [8, 0, 0]],
}

const spline: EdgeCurve = {
  id: 'e_spline',
  kind: 'b-spline',
  point: [1, 1, 0],
  endpoints: [[0, 0, 0], [2, 0, 0]],
  points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]],
}

function expectClose(a: readonly number[], b: readonly number[]) {
  expect(a).toHaveLength(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6))
}

describe('sampleEdgeCurve: line', () => {
  it('samples to exactly its two endpoints', () => {
    expect(sampleEdgeCurve(line)).toEqual([[0, 0, 0], [10, 0, 0]])
  })

  it('ignores resolution: a line needs no refinement', () => {
    expect(sampleEdgeCurve(line, 4)).toHaveLength(2)
    expect(sampleEdgeCurve(line, 256)).toHaveLength(2)
  })
})

describe('sampleEdgeCurve: circle', () => {
  it('samples a full circle to a closed loop on the analytic circle', () => {
    const pts = sampleEdgeCurve(circle(0, 2 * Math.PI))
    for (const p of pts) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 6)
      expect(p[2]).toBeCloseTo(0, 6)
    }
    // Closed: the sweep lands back on its start rather than leaving a gap.
    expectClose(pts[pts.length - 1], pts[0])
  })

  it('respects an arc\'s endpoints', () => {
    const arc = circle(0, Math.PI / 2)
    const pts = sampleEdgeCurve(arc)
    expectClose(pts[0], arc.endpoints[0])
    expectClose(pts[pts.length - 1], arc.endpoints[1])
  })

  it('stays on the analytic arc between its endpoints', () => {
    const pts = sampleEdgeCurve(circle(Math.PI / 4, Math.PI))
    for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 6)
  })

  it('sweeps in a plane skewed off the world axes', () => {
    const skew: EdgeCurve = {
      ...circle(0, 2 * Math.PI),
      point: [1, 2, 3],
      axis: [0, 1, 0],
      x_axis: [0, 0, 1],
    }
    const pts = sampleEdgeCurve(skew)
    for (const p of pts) {
      expect(p[1]).toBeCloseTo(2, 6)  // stays in the plane through the center
      expect(Math.hypot(p[0] - 1, p[2] - 3)).toBeCloseTo(5, 6)
    }
  })

  it('scales its sample count with the requested resolution', () => {
    const full = circle(0, 2 * Math.PI)
    const coarse = sampleEdgeCurve(full, 8)
    const fine = sampleEdgeCurve(full, 64)
    expect(coarse).toHaveLength(9)   // segs + 1 points
    expect(fine).toHaveLength(65)
    expect(fine.length).toBeGreaterThan(coarse.length)
  })

  it('gives a quarter arc a quarter of a full turn\'s segments', () => {
    const quarter = sampleEdgeCurve(circle(0, Math.PI / 2), 64)
    expect(quarter).toHaveLength(17)  // 64/4 = 16 segments
  })
})

describe('sampleEdgeCurve: ellipse', () => {
  it('honours the minor radius rather than sweeping a circle', () => {
    const pts = sampleEdgeCurve(ellipse, 8)
    // p(t) = c + a*cos(t)*x + b*sin(t)*y  =>  quarter turn lands on the minor axis
    expectClose(pts[2], [0, 3, 0])
    for (const p of pts) {
      expect((p[0] / 8) ** 2 + (p[1] / 3) ** 2).toBeCloseTo(1, 6)
    }
  })
})

describe('sampleEdgeCurve: b-spline', () => {
  it('replays the tessellated polyline the bundle carried', () => {
    expect(sampleEdgeCurve(spline)).toEqual([[0, 0, 0], [1, 1, 0], [2, 0, 0]])
  })
})

describe('sampleEdgeCurve: degradation', () => {
  // These curves can only come from a bundle cached before the parametric fields
  // existed. Fail safe (a chord) rather than throw inside the render tree.
  it('falls back to the chord when a circle has no parametric fields', () => {
    const bare: EdgeCurve = {
      id: 'e', kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1], radius: 5,
      endpoints: [[5, 0, 0], [0, 5, 0]],
    }
    expect(sampleEdgeCurve(bare)).toEqual([[5, 0, 0], [0, 5, 0]])
  })

  it('falls back to the chord when an ellipse has no minor radius', () => {
    const bare: EdgeCurve = { ...ellipse, minor_radius: undefined }
    expect(sampleEdgeCurve(bare)).toHaveLength(2)
  })

  it('falls back to the chord when a spline has no interior points', () => {
    const bare: EdgeCurve = { ...spline, points: undefined }
    expect(sampleEdgeCurve(bare)).toEqual([[0, 0, 0], [2, 0, 0]])
  })

  it('falls back to the chord when x_axis is parallel to the axis', () => {
    const degenerate: EdgeCurve = { ...circle(0, Math.PI), x_axis: [0, 0, 1] }
    expect(sampleEdgeCurve(degenerate)).toHaveLength(2)
  })
})

describe('segmentCount', () => {
  it('never drops below two segments, however short the sweep', () => {
    expect(segmentCount(1e-6, 64)).toBe(2)
  })

  it('is proportional to the sweep', () => {
    expect(segmentCount(2 * Math.PI, 64)).toBe(64)
    expect(segmentCount(Math.PI, 64)).toBe(32)
  })

  it('is sign-agnostic: a reversed sweep gets the same count', () => {
    expect(segmentCount(-Math.PI, 64)).toBe(segmentCount(Math.PI, 64))
  })
})

describe('buildCurveSegments', () => {
  it('emits one 6-float pair per polyline segment', () => {
    const out = buildCurveSegments([line])
    expect(out).toBeInstanceOf(Float32Array)
    expect(Array.from(out)).toEqual([0, 0, 0, 10, 0, 0])
  })

  it('concatenates every curve of a body', () => {
    const out = buildCurveSegments([line, spline])
    expect(out).toHaveLength((1 + 2) * 6)
  })

  it('scales with resolution', () => {
    const coarse = buildCurveSegments([circle(0, 2 * Math.PI)], 8)
    const fine = buildCurveSegments([circle(0, 2 * Math.PI)], 32)
    expect(coarse).toHaveLength(8 * 6)
    expect(fine).toHaveLength(32 * 6)
  })

  it('drops segments with non-finite points instead of streaking the scene', () => {
    const broken: EdgeCurve = {
      id: 'e', kind: 'line', point: [0, 0, 0],
      endpoints: [[0, 0, 0], [NaN, 0, 0]],
    }
    expect(buildCurveSegments([broken, line])).toHaveLength(6)
  })

  it('returns an empty buffer for a body with no edges', () => {
    expect(buildCurveSegments([])).toHaveLength(0)
  })

  it('defaults to the full-turn resolution constant', () => {
    const out = buildCurveSegments([circle(0, 2 * Math.PI)])
    expect(out).toHaveLength(DEFAULT_CURVE_RESOLUTION * 6)
  })
})

describe('buildIndexedCurveSegments', () => {
  it('carries the same positions the visible overlay draws', () => {
    const curves = [line, circle(0, 2 * Math.PI)]
    expect([...buildIndexedCurveSegments(curves).positions]).toEqual([...buildCurveSegments(curves)])
  })

  it('names the curve each segment came from', () => {
    const { segmentToCurve } = buildIndexedCurveSegments([line, circle(0, Math.PI)], 8)
    expect(segmentToCurve[0]).toBe(0)
    expect(segmentToCurve.filter(i => i === 0)).toHaveLength(1)  // the line is one segment
    expect(segmentToCurve.filter(i => i === 1)).toHaveLength(4)  // a half turn of 8
  })

  it('keeps ownership when a degenerate segment is dropped', () => {
    const broken: EdgeCurve = {
      id: 'e', kind: 'line', point: [0, 0, 0],
      endpoints: [[0, 0, 0], [NaN, 0, 0]],
    }
    // The broken curve contributes nothing, so the surviving segment must still
    // name curve 1 -- not curve 0, which it would if indices were positional.
    const { positions, segmentToCurve } = buildIndexedCurveSegments([broken, line])
    expect(positions).toHaveLength(6)
    expect([...segmentToCurve]).toEqual([1])
  })

  it('has one owner per segment', () => {
    const { positions, segmentToCurve } = buildIndexedCurveSegments([line, ellipse, spline])
    expect(segmentToCurve.length).toBe(positions.length / 6)
  })
})
