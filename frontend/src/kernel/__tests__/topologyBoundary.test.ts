// Shared boundary tessellation used by the 3D sketch fill + surface picking.
// Each topology edge kind (line, arc, spline, ellipse) must contribute a sane
// closed polygon -- the area builder produces the boundary, this turns it into
// pickable/fillable geometry.
import { describe, it, expect } from 'vitest'
import { tessellateBoundary } from '../topologyBoundary'
import type { TopologyEdge } from '@/types/cad'

describe('tessellateBoundary', () => {
  it('a triangle of lines yields its three corners', () => {
    const boundary = [
      { kind: 'line', start: [0, 0], end: [4, 0] },
      { kind: 'line', start: [4, 0], end: [0, 3] },
      { kind: 'line', start: [0, 3], end: [0, 0] },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary)
    // start of first edge + one end per edge.
    expect(pts).toEqual([[0, 0], [4, 0], [0, 3], [0, 0]])
  })

  it('a line + spline loop bulges off the chord (curve is sampled)', () => {
    const boundary = [
      { kind: 'line', start: [0, 0], end: [4, 0] },
      { kind: 'spline', start: [4, 0], end: [0, 0], c1: [3, 3], c2: [1, 3] },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary, 8)
    expect(pts.length).toBeGreaterThan(4)
    expect(pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    // Some sampled point rises above the y=0 base chord.
    expect(Math.max(...pts.map((p) => p[1]))).toBeGreaterThan(0.5)
  })

  it('a full ellipse becomes a closed polygon spanning its semi-axes', () => {
    const boundary = [
      { kind: 'ellipse', center: [3, 1], a: 4, b: 2, theta: 0, start_vertex: null, end_vertex: null, id: 'e1' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary, 32)
    expect(pts.length).toBe(32)
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.max(...xs)).toBeCloseTo(7, 6)
    expect(Math.min(...xs)).toBeCloseTo(-1, 6)
    expect(Math.max(...ys)).toBeCloseTo(3, 6)
    expect(Math.min(...ys)).toBeCloseTo(-1, 6)
  })

  it('a rotated ellipse spans its rotated major axis', () => {
    // theta = 90deg: the major axis (a=4) lies along y, the minor (b=2) along x.
    const boundary = [
      { kind: 'ellipse', center: [0, 0], a: 4, b: 2, theta: 90, start_vertex: null, end_vertex: null, id: 'e1' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary, 64)
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.max(...ys)).toBeCloseTo(4, 6)
    expect(Math.max(...xs)).toBeCloseTo(2, 6)
  })

  it('a CCW arc sweeps from start to end along the circle', () => {
    // quarter circle, radius 5 about the origin, 0deg -> 90deg counter-clockwise.
    const boundary = [
      { kind: 'arc', start: [5, 0], end: [0, 5], center: [0, 0], radius: 5,
        angle_start_deg: 0, angle_end_deg: 90, ccw: true, start_vertex: 'a', end_vertex: 'b' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary)
    // first edge pushes its start, then one sampled point per step to the end.
    expect(pts[0]).toEqual([5, 0])
    expect(pts[pts.length - 1][0]).toBeCloseTo(0, 6)
    expect(pts[pts.length - 1][1]).toBeCloseTo(5, 6)
    // every sampled point lies on the radius-5 circle and stays in the first quadrant.
    for (const [x, y] of pts) {
      expect(Math.hypot(x, y)).toBeCloseTo(5, 6)
      expect(x).toBeGreaterThanOrEqual(-1e-9)
      expect(y).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  it('a CW arc sweeps the opposite way for the same endpoints', () => {
    // same endpoints as above but ccw=false: the negative-span branch of arcPts.
    const boundary = [
      { kind: 'arc', start: [0, 5], end: [5, 0], center: [0, 0], radius: 5,
        angle_start_deg: 90, angle_end_deg: 0, ccw: false, start_vertex: 'a', end_vertex: 'b' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary)
    expect(pts[0]).toEqual([0, 5])
    expect(pts[pts.length - 1][0]).toBeCloseTo(5, 6)
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6)
    for (const [x, y] of pts) {
      expect(Math.hypot(x, y)).toBeCloseTo(5, 6)
    }
  })

  it('a CCW ellipse arc wraps the end angle past the start (p1 += 2pi)', () => {
    // 270deg -> 0deg CCW: end angle is below start, so the ccw branch adds 2pi.
    const boundary = [
      { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2, theta: 0,
        angle_start_deg: 270, angle_end_deg: 0, ccw: true,
        start: [0, -2], end: [4, 0], start_vertex: 'a', end_vertex: 'b' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary)
    // first edge pushes start [0,-2]; the arc runs through the +x cap [4,0].
    expect(pts[0]).toEqual([0, -2])
    expect(pts[pts.length - 1][0]).toBeCloseTo(4, 6)
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6)
    expect(pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    // every point sits on the ellipse: (x/a)^2 + (y/b)^2 == 1.
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i]
      expect((x / 4) ** 2 + (y / 2) ** 2).toBeCloseTo(1, 6)
    }
  })

  it('a CW ellipse arc wraps the end angle below the start (p1 -= 2pi)', () => {
    // 0deg -> 90deg with ccw=false: end angle is above start, so it subtracts 2pi.
    const boundary = [
      { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2, theta: 0,
        angle_start_deg: 0, angle_end_deg: 90, ccw: false,
        start: [4, 0], end: [0, 2], start_vertex: 'a', end_vertex: 'b' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary)
    expect(pts[0]).toEqual([4, 0])
    // the long way round (-270deg) still terminates at the +y cap [0,2].
    expect(pts[pts.length - 1][0]).toBeCloseTo(0, 6)
    expect(pts[pts.length - 1][1]).toBeCloseTo(2, 6)
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i]
      expect((x / 4) ** 2 + (y / 2) ** 2).toBeCloseTo(1, 6)
    }
  })

  it('treats a missing theta as no rotation (ellipse + ellipse arc)', () => {
    // theta omitted exercises the `theta ?? 0` fallback in both ellipse paths.
    const boundary = [
      { kind: 'ellipse', center: [0, 0], a: 4, b: 2, start_vertex: null, end_vertex: null, id: 'e1' },
    ] as unknown as TopologyEdge[]
    const pts = tessellateBoundary(boundary, 16)
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(4, 6)
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(2, 6)

    const arcBoundary = [
      { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2,
        angle_start_deg: 0, angle_end_deg: 90, ccw: true,
        start: [4, 0], end: [0, 2], start_vertex: 'a', end_vertex: 'b' },
    ] as unknown as TopologyEdge[]
    const arcPts = tessellateBoundary(arcBoundary)
    expect(arcPts[arcPts.length - 1][0]).toBeCloseTo(0, 6)
    expect(arcPts[arcPts.length - 1][1]).toBeCloseTo(2, 6)
  })
})
