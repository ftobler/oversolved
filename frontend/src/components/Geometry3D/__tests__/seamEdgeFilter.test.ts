import { describe, it, expect } from 'vitest'
import type { EdgeData, Mesh3D } from '@/types/cad'
import { buildEdgeSegments, getEdgeSegmentCounts, buildFaceBoundarySegments } from '../bodyGeometry'

const CIRCLE_EDGE: EdgeData = {
  kind: 'circle',
  center: [0, 0, 0],
  radius: 1,
  axis: [0, 0, 1],
  x_axis: [1, 0, 0],
  angle_start: 0,
  angle_end: Math.PI * 2,
}

const SEAM_LINE_EDGE: EdgeData = {
  kind: 'line',
  start: [1, 0, 0],
  end: [1, 0, 2],
  seam: true,
}

const LINE_EDGE: EdgeData = {
  kind: 'line',
  start: [0, 0, 0],
  end: [1, 0, 0],
}

describe('seamEdgeFilter', () => {
  it('seam edge is excluded from segment positions', () => {
    const edges: EdgeData[] = [CIRCLE_EDGE, SEAM_LINE_EDGE]
    const segs = buildEdgeSegments(edges)
    // A full circle produces ARC_SEGMENTS (64) segments, each 6 floats = 384 floats.
    // The seam line would add 6 floats. We expect only circle segments.
    expect(segs.length).toBeGreaterThan(0)
    // The seam line endpoints are [1,0,0] -> [1,0,2]. If any seam leaked, we'd
    // find z=2 in the buffer.
    const hasSeamZ = Array.from(segs).some(v => Math.abs(v - 2) < 1e-6)
    expect(hasSeamZ).toBe(false)
  })

  it('getEdgeSegmentCounts returns 0 for seam edges', () => {
    const edges: EdgeData[] = [LINE_EDGE, SEAM_LINE_EDGE, CIRCLE_EDGE]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts).toHaveLength(3)
    expect(counts[0]).toBe(1)   // normal line
    expect(counts[1]).toBe(0)   // seam line
    expect(counts[2]).toBeGreaterThan(0)  // circle
  })

  it('non-seam edges are unaffected', () => {
    const edges: EdgeData[] = [LINE_EDGE, CIRCLE_EDGE]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts[0]).toBe(1)
    expect(counts[1]).toBeGreaterThan(0)
    const segs = buildEdgeSegments(edges)
    expect(segs.length).toBeGreaterThan(0)
  })

  it('seam arc is also excluded', () => {
    const seamArc: EdgeData = {
      kind: 'arc',
      center: [0, 0, 0],
      radius: 1,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI,
      seam: true,
    }
    const edges: EdgeData[] = [seamArc]
    const counts = getEdgeSegmentCounts(edges)
    expect(counts[0]).toBe(0)
    const segs = buildEdgeSegments(edges)
    expect(segs.length).toBe(0)
  })
})

describe('buildFaceBoundarySegments seam suppression', () => {
  // Minimal cylinder-face mesh: 4 triangles forming a quad strip.
  // Vertices 0-3 are at the "left" seam (u=0), vertices 4-7 are at the "right" seam (u=2π),
  // but at the same world positions. The seam edge runs v0-v3 / v4-v7 (same world coords).
  //
  //  v3 (=v7)  v2 (=v6)
  //   |  \   |
  //  v0 (=v4)  v1 (=v5)
  //
  // face 0: triangle [0, 1, 2]  → edges 0:1, 1:2, 0:2
  // face 1: triangle [0, 2, 3]  → edges 0:2, 2:3, 0:3   (edge 0:2 shared = interior)
  // face 2: triangle [4, 5, 6]  → edges 4:5, 5:6, 4:6
  // face 3: triangle [4, 6, 7]  → edges 4:6, 6:7, 4:7
  //
  // Boundary edges of face 0 (brepFaceIndex=0, tris 0+1): 0:1, 1:2, 2:3, 0:3
  //   0:1 and 2:3 are the top/bottom caps.
  //   0:3 and 1:2... wait, let me build a cleaner example.

  it('suppresses coincident boundary edges (seam artifact)', () => {
    // Simple: a strip of 2 triangles where the "open" edge appears twice
    // at the same world position (seam duplicate).
    //
    // verts: 0=(0,0,0), 1=(1,0,0), 2=(1,1,0), 3=(0,1,0)  ← face 0 strip
    //        4=(0,0,0), 5=(0,1,0)                          ← same positions as 0 and 3
    //
    // tri 0: [0,1,2], tri 1: [0,2,3]  → boundary: 0:1, 1:2, 2:3, 0:3
    // But we want to model the seam: edge 0:3 is coincident with edge 4:5.
    // Only face 0 triangles here so 0:3 appears once (boundary).
    // Then we add edge 4:5 which would appear once in a second face (boundary too).
    // Since they're at the same world pos, both should be suppressed.
    //
    // Simplest test: create a mesh with ONE face (brepFaceIndex=0) whose boundary
    // includes two coincident edges (simulating the seam side).

    const verts: [number, number, number][] = [
      [0, 0, 0],  // 0 = left-seam bottom
      [1, 0, 0],  // 1 = right side bottom
      [1, 1, 0],  // 2 = right side top
      [0, 1, 0],  // 3 = left-seam top
      [0, 0, 0],  // 4 = duplicate of 0 (seam u=2π)
      [0, 1, 0],  // 5 = duplicate of 3 (seam u=2π)
    ]
    // Two tris forming the face, sharing edge 0:2.
    // Boundary of these two tris: 0:1, 1:2, 2:3, 0:3
    // We add two more tris from the "other side of the seam" that share
    // the coincident edge 4:5 (= world-space 0:3).
    const faceTris: [number, number, number][] = [
      [0, 1, 2],  // face 0 tri 0
      [0, 2, 3],  // face 0 tri 1
      [4, 5, 2],  // face 0 tri 2 — uses duplicate verts 4=0, 5=3
      [4, 2, 1],  // face 0 tri 3 — uses duplicate vert 4=0
    ]
    // triangle_to_face: all 4 triangles belong to face 0
    const mesh: Mesh3D = {
      vertices: verts,
      faces: faceTris,
      triangle_to_face: [0, 0, 0, 0],
    }
    const result = buildFaceBoundarySegments(mesh, 0)
    // Boundary edges:
    //  0:1 once (tris 0 and 3 share it? No: tri 0 has 0:1, tri 3 has 1:4 = 0:4 = 0:0 = same pos...
    // This is getting complex. Use a simpler targeted test:
    // Just verify the seam edge 0:3 / 4:5 (same world pos) are NOT in the output.
    // All output segments should not contain the x=0 vertical line.
    const pts = Array.from(result)
    // Segments are pairs: [x0,y0,z0, x1,y1,z1]. Seam is x=0, y from 0 to 1.
    // Check no segment has both endpoints at x=0:
    for (let i = 0; i < pts.length; i += 6) {
      const bothAtX0 = Math.abs(pts[i]) < 1e-6 && Math.abs(pts[i + 3]) < 1e-6
      expect(bothAtX0).toBe(false)
    }
  })

  it('keeps real boundary edges that happen to touch x=0', () => {
    // A simple triangle fan where x=0 edges are real boundaries (not duplicated).
    const verts: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]
    const mesh: Mesh3D = {
      vertices: verts,
      faces: [[0, 1, 2], [0, 2, 3]],
      triangle_to_face: [0, 0],
    }
    const result = buildFaceBoundarySegments(mesh, 0)
    // 4 boundary edges: 0:1, 1:2, 2:3, 0:3. None coincident. All should appear.
    expect(result.length).toBe(4 * 6)  // 4 segments × 6 floats
  })
})
