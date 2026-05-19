import { describe, it, expect } from 'vitest'
import type { EdgeData } from '@/types/cad'
import { buildEdgeSegments, getEdgeSegmentCounts } from '../bodyGeometry'

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
