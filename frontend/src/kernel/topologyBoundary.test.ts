// Shared boundary tessellation used by the 3D sketch fill + surface picking.
// Each topology edge kind (line, arc, spline, ellipse) must contribute a sane
// closed polygon -- the area builder produces the boundary, this turns it into
// pickable/fillable geometry.
import { describe, it, expect } from 'vitest'
import { tessellateBoundary } from './topologyBoundary'
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
})
