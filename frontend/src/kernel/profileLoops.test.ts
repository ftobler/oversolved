// Always-on unit tests for the pure loop-classification helpers behind the
// extrude leaf: loopSignedArea, pointInLoop, classifyLoops. No OCC.

import { describe, it, expect } from 'vitest'
import { loopSignedArea, pointInLoop, classifyLoops, subdivideLoops, loopCentroid, arcSamplePoints, ellipseArcSamplePoints, loopPts, type LoopEdge } from './profileLoops'
import { extractProfileLoops } from './features/shared'

const square = (s: number): LoopEdge[] => [
  { kind: 'line', start: [0, 0], end: [s, 0] },
  { kind: 'line', start: [s, 0], end: [s, s] },
  { kind: 'line', start: [s, s], end: [0, s] },
  { kind: 'line', start: [0, s], end: [0, 0] },
]

// A small square centered at (cx, cy) with half-size h.
const box = (cx: number, cy: number, h: number): LoopEdge[] => [
  { kind: 'line', start: [cx - h, cy - h], end: [cx + h, cy - h] },
  { kind: 'line', start: [cx + h, cy - h], end: [cx + h, cy + h] },
  { kind: 'line', start: [cx + h, cy + h], end: [cx - h, cy + h] },
  { kind: 'line', start: [cx - h, cy + h], end: [cx - h, cy - h] },
]

const rect = (x0: number, y0: number, x1: number, y1: number): LoopEdge[] => [
  { kind: 'line', start: [x0, y0], end: [x1, y0] },
  { kind: 'line', start: [x1, y0], end: [x1, y1] },
  { kind: 'line', start: [x1, y1], end: [x0, y1] },
  { kind: 'line', start: [x0, y1], end: [x0, y0] },
]

function arcEdge(cx: number, cy: number, r: number, aStartDeg: number, aEndDeg: number, ccw = true): LoopEdge {
  const a0 = aStartDeg * Math.PI / 180
  const a1 = aEndDeg * Math.PI / 180
  return {
    kind: 'arc',
    center: [cx, cy],
    radius: r,
    angle_start_deg: aStartDeg,
    angle_end_deg: aEndDeg,
    ccw,
    start: [cx + r * Math.cos(a0), cy + r * Math.sin(a0)],
    end: [cx + r * Math.cos(a1), cy + r * Math.sin(a1)],
  }
}

describe('loopSignedArea', () => {
  it('is positive (CCW) and equals the area for a square', () => {
    // 10x10 CCW square: area should be +100
    expect(loopSignedArea(square(10))).toBeCloseTo(100, 9)
  })
  it('flips sign for a reversed (CW) loop', () => {
    expect(loopSignedArea([...square(10)].reverse().map((e) => ({
      kind: 'line',
      start: e.end,
      end: e.start,
    })))).toBeCloseTo(-100, 9)
  })
})

describe('pointInLoop', () => {
  it('detects interior and exterior points', () => {
    const s = square(10)
    expect(pointInLoop([5, 5], s)).toBe(true)
    expect(pointInLoop([15, 5], s)).toBe(false)
    expect(pointInLoop([-1, 5], s)).toBe(false)
  })
})

describe('classifyLoops', () => {
  it('returns a single outer with no holes', () => {
    const groups = classifyLoops([square(10)])
    expect(groups).toHaveLength(1)
    expect(groups[0][1]).toHaveLength(0)
  })

  it('nests a contained loop as a hole of the smallest enclosing outer', () => {
    const outer = square(20)
    const hole = box(10, 10, 2)
    const groups = classifyLoops([outer, hole])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(outer)
    expect(holes).toEqual([hole])
  })

  it('keeps disjoint loops as independent outers', () => {
    const a = box(5, 5, 2)
    const b = box(50, 50, 2)
    const groups = classifyLoops([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every(([, holes]) => holes.length === 0)).toBe(true)
  })
})

// ─── extractProfileLoops ───

function surfaceFromEdges(edges: [number[], number[]][]): Record<string, unknown> {
  return { boundary: edges.map(([s, e]) => ({ start: [...s], end: [...e] })) }
}

function loopPoints(loop: Record<string, unknown>[]): number[][] {
  return loop.map((e) => e.start as number[])
}

function shoelaceArea(loop: Record<string, unknown>[]): number {
  const pts = loopPoints(loop)
  const n = pts.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return Math.abs(area) / 2
}

describe('extractProfileLoops', () => {
  it('ordered square produces one loop', () => {
    const edges: [number[], number[]][] = [
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
    const pts = new Set(loops[0].map((e) => JSON.stringify(e.start)))
    expect(pts.has(JSON.stringify([0, 0]))).toBe(true)
    expect(pts.has(JSON.stringify([1, 0]))).toBe(true)
    expect(pts.has(JSON.stringify([1, 1]))).toBe(true)
    expect(pts.has(JSON.stringify([0, 1]))).toBe(true)
  })

  it('unordered square still produces loop', () => {
    const edges: [number[], number[]][] = [
      [[1, 1], [0, 1]],
      [[0, 0], [1, 0]],
      [[0, 1], [0, 0]],
      [[1, 0], [1, 1]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
  })

  it('triangle produces three point loop', () => {
    const edges: [number[], number[]][] = [
      [[0, 0], [2, 0]],
      [[2, 0], [1, 2]],
      [[1, 2], [0, 0]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(3)
  })

  it('pentagon produces five point loop', () => {
    const pts = Array.from({ length: 5 }, (_, i) => [
      Math.cos((2 * Math.PI * i) / 5),
      Math.sin((2 * Math.PI * i) / 5),
    ])
    const edges: [number[], number[]][] = pts.map((p, i) => [p, pts[(i + 1) % 5]])
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(5)
  })

  it('broken loop falls back, does not crash', () => {
    const edges: [number[], number[]][] = [
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[1, 1], [0, 1]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(Array.isArray(loops)).toBe(true)
  })

  it('empty surface returns empty', () => {
    const loops = extractProfileLoops([{ boundary: [] }])
    expect(Array.isArray(loops)).toBe(true)
  })

  it('no surfaces returns empty', () => {
    const loops = extractProfileLoops([])
    expect(loops).toEqual([])
  })

  it('two surfaces outer and hole', () => {
    const outer: [number[], number[]][] = [
      [[0, 0], [4, 0]],
      [[4, 0], [4, 4]],
      [[4, 4], [0, 4]],
      [[0, 4], [0, 0]],
    ]
    const hole: [number[], number[]][] = [
      [[1, 1], [3, 1]],
      [[3, 1], [3, 3]],
      [[3, 3], [1, 3]],
      [[1, 3], [1, 1]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(outer), surfaceFromEdges(hole)])
    expect(loops).toHaveLength(2)
    const areas = loops.map(shoelaceArea)
    expect(Math.max(...areas)).toBeCloseTo(16.0, 0)
    expect(Math.min(...areas)).toBeCloseTo(4.0, 0)
  })

  it('near-touching within tolerance chains', () => {
    const eps = 1e-7
    const edges: [number[], number[]][] = [
      [[0, 0], [1, 0]],
      [[1 + eps, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
  })

  it('gap outside tolerance falls back', () => {
    const edges: [number[], number[]][] = [
      [[0, 0], [1, 0]],
      [[1.1, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ]
    const loops = extractProfileLoops([surfaceFromEdges(edges)])
    expect(Array.isArray(loops)).toBe(true)
  })
})

describe('subdivideLoops', () => {
  it('returns empty/single trivially', () => {
    expect(subdivideLoops([])).toEqual([])
    const one = subdivideLoops([square(10)])
    expect(one).toHaveLength(1)
    expect(one[0][1]).toHaveLength(0)
  })

  it('keeps the nested loop as a hole AND its own filled face', () => {
    // The even/odd classifyLoops drops the inner disk; subdivideLoops keeps it.
    const outer = square(20)
    const hole = box(10, 10, 2)
    const groups = subdivideLoops([outer, hole])
    expect(groups).toHaveLength(2)
    const ring = groups.find((g) => g[0] === outer)!
    const disk = groups.find((g) => g[0] === hole)!
    expect(ring[1]).toEqual([hole])  // outer carries the inner as a hole
    expect(disk[1]).toHaveLength(0)  // inner is also its own face
  })

  it('every level of a triple nest is its own face', () => {
    const a = box(0, 0, 10)
    const b = box(0, 0, 6)
    const c = box(0, 0, 2)
    const groups = subdivideLoops([a, b, c])
    expect(groups).toHaveLength(3)
    expect(groups.find((g) => g[0] === a)![1]).toEqual([b])  // a's hole is b
    expect(groups.find((g) => g[0] === b)![1]).toEqual([c])  // b's hole is c
    expect(groups.find((g) => g[0] === c)![1]).toEqual([])  // c is a solid disk
  })

  it('keeps disjoint loops as independent holeless faces', () => {
    const a = box(5, 5, 2)
    const b = box(50, 50, 2)
    const groups = subdivideLoops([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every(([, holes]) => holes.length === 0)).toBe(true)
  })
})

describe('classifyLoops additional', () => {
  it('returns empty array for empty input', () => {
    expect(classifyLoops([])).toEqual([])
  })

  it('returns independent outers for two identical loops', () => {
    const a = rect(0, 0, 2, 2)
    const b = rect(0, 0, 2, 2)
    const groups = classifyLoops([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every(([, holes]) => holes.length === 0)).toBe(true)
  })

  it('is order independent when hole is listed before outer', () => {
    const outer = rect(0, 0, 4, 4)
    const hole = rect(1, 1, 3, 3)
    // hole listed before outer
    const groups = classifyLoops([hole, outer])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(outer)
    expect(holes[0]).toBe(hole)
  })

  it('handles outer with hole and a disjoint loop', () => {
    const big = rect(0, 0, 10, 10)
    const inner = rect(1, 1, 4, 4)
    const separate = rect(20, 20, 25, 25)
    const groups = classifyLoops([big, inner, separate])
    expect(groups).toHaveLength(2)
    const bigGroup = groups.find((g) => g[0] === big)!
    const sepGroup = groups.find((g) => g[0] === separate)!
    expect(bigGroup[1]).toHaveLength(1)
    expect(bigGroup[1][0]).toBe(inner)
    expect(sepGroup[1]).toEqual([])
  })

  it('treats shared-boundary loops as independent outers', () => {
    /** Two non-overlapping loops whose edge endpoints touch: both independent outers.
     *  Loop A: (0,0)-(1,0)-(1,1)-(0,1), Loop B: (1,0)-(2,0)-(2,1)-(1,1).
     *  They share the edge x=1, so start points of B lie on A's boundary. */
    const a = rect(0, 0, 1, 1)
    const b = rect(1, 0, 2, 1)
    const groups = classifyLoops([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every(([, holes]) => holes.length === 0)).toBe(true)
  })

  it('classifies hole whose start touches outer boundary correctly', () => {
    /** Hole whose start point lies on the outer loop's boundary is still classified
     *  correctly.  Outer: (0,0)-(4,0)-(4,4)-(0,4).
     *  Hole: (2,0)-(3,0)-(3,2)-(2,2) -- bottom edge of hole starts on outer's bottom edge. */
    const outer = rect(0, 0, 4, 4)
    const hole = rect(2, 0, 3, 2)
    const groups = classifyLoops([outer, hole])
    // hole centroid (2.5, 1.0) is strictly inside outer; must be a hole
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(outer)
    expect(holes).toHaveLength(1)
    expect(holes[0]).toBe(hole)
  })

  it('classifies concave outer (L-shape) with hole inside', () => {
    /** Concave outer (L-shape) with a hole inside is classified correctly. */
    const lShape: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [4, 0] },
      { kind: 'line', start: [4, 0], end: [4, 2] },
      { kind: 'line', start: [4, 2], end: [2, 2] },
      { kind: 'line', start: [2, 2], end: [2, 4] },
      { kind: 'line', start: [2, 4], end: [0, 4] },
      { kind: 'line', start: [0, 4], end: [0, 0] },
    ]
    const hole = rect(0.5, 0.5, 1.5, 1.5)
    const groups = classifyLoops([lShape, hole])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(lShape)
    expect(holes).toHaveLength(1)
    expect(holes[0]).toBe(hole)
  })

  it('classifies arc-containing outer loop with inner hole', () => {
    /** Loop containing an arc (bulging outward) should still classify as outer. */
    const arcLoop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [4, 0] },
      { kind: 'line', start: [4, 0], end: [4, 4] },
      arcEdge(2, 4, 2, 0, 180),
      { kind: 'line', start: [0, 4], end: [0, 0] },
    ]
    const inner = rect(1, 1, 3, 3)
    const groups = classifyLoops([arcLoop, inner])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(arcLoop)
    expect(holes[0]).toBe(inner)
  })

  it('handles arc-only loop without start keys without crashing', () => {
    /** classify_loops should work when the loop has no 'start' keys (OCC arcs). */
    const arcOnly: LoopEdge[] = [
      { kind: 'arc', center: [0, 0], radius: 5.0, angle_start_deg: 0.0, angle_end_deg: 180.0, ccw: true },
    ]
    const groups = classifyLoops([arcOnly])
    expect(groups).toHaveLength(1)
  })

  it('classifies small-arc loop as outer, not a hole', () => {
    /** Loop containing a very small arc (< 5 degrees) is outer, not a hole.
     *  The arc midpoint can lie on the concave side of a tight-radius arc.
     *  Using the centroid as rep point must classify this loop as an outer boundary. */
    const r = 10.0
    const aStart = 0.0
    const aEnd = 3.0
    const arc = arcEdge(0.0, 0.0, r, aStart, aEnd)
    const arcStart = arc.start as number[]
    const arcEnd = arc.end as number[]
    const midAngle = 1.5 * Math.PI / 180
    const apex = [r * Math.cos(midAngle), r * Math.sin(midAngle) + 2.0]
    const loop: LoopEdge[] = [
      arc,
      { kind: 'line', start: arcEnd, end: apex },
      { kind: 'line', start: apex, end: arcStart },
    ]
    const groups = classifyLoops([loop])
    expect(groups).toHaveLength(1)
    expect(groups[0][1]).toEqual([])
  })

  it('classifies small-arc loop inside outer rect as a hole', () => {
    /** Outer rect + inner small-arc loop: inner is classified as a hole. */
    const outer = rect(-5, -5, 5, 5)
    const r = 0.5
    const arc = arcEdge(0.0, 0.0, r, 0.0, 3.0)
    const arcStart = arc.start as number[]
    const arcEnd = arc.end as number[]
    const midAngle = 1.5 * Math.PI / 180
    const apex = [r * Math.cos(midAngle), r * Math.sin(midAngle) + 0.1]
    const inner: LoopEdge[] = [
      arc,
      { kind: 'line', start: arcEnd, end: apex },
      { kind: 'line', start: apex, end: arcStart },
    ]
    const groups = classifyLoops([outer, inner])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(outer)
    expect(holes).toHaveLength(1)
    expect(holes[0]).toBe(inner)
  })
})

describe('loopSignedArea additional', () => {
  it('computes larger area for loop with outward-bulging arc', () => {
    /** A CCW loop with a semicircle arc bulging outward should have larger area
     *  than the chord-only approximation would give. */
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [2, 0] },
      { kind: 'line', start: [2, 0], end: [2, 1] },
      arcEdge(1, 1, 1, 0, 180),
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    const area = loopSignedArea(loop)
    expect(area).toBeGreaterThan(2.5)
    expect(area).toBeGreaterThan(0)
  })

  it('does not crash on arc edge without start keys', () => {
    /** OCC-sourced arc dicts without 'start'/'end' keys should not crash. */
    const e: LoopEdge = { kind: 'arc', center: [0, 0], radius: 1.0, angle_start_deg: 0.0, angle_end_deg: 90.0, ccw: true }
    // Only 1 point (the midpoint) -- too few for a real area, returns 0
    expect(loopSignedArea([e])).toBe(0.0)
  })
})

describe('pointInLoop additional', () => {
  it('arc midpoint matters for point inside arc bulge', () => {
    /** A point that lies inside the arc bulge but outside the chord polygon
     *  should be correctly detected as inside when arc midpoints are sampled. */
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [2, 0] },
      { kind: 'line', start: [2, 0], end: [2, 1] },
      arcEdge(1, 1, 1, 0, 180),
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    expect(pointInLoop([1.0, 1.8], loop)).toBe(true)
    expect(pointInLoop([1.0, 3.0], loop)).toBe(false)
  })
})

describe('loopCentroid', () => {
  it('returns center of a 1x1 square at origin', () => {
    const loop = rect(0, 0, 1, 1)
    const [cx, cy] = loopCentroid(loop)
    expect(cx).toBeCloseTo(0.5, 9)
    expect(cy).toBeCloseTo(0.5, 9)
  })

  it('returns [0, 0] for empty loop', () => {
    expect(loopCentroid([])).toEqual([0.0, 0.0])
  })

  it('returns [0, 0] for loop with only one edge', () => {
    const loop: LoopEdge[] = [{ kind: 'line', start: [0, 0], end: [1, 0] }]
    expect(loopCentroid(loop)).toEqual([0.0, 0.0])
  })

  it('returns correct centroid for offset rectangle', () => {
    const loop = rect(2, 3, 6, 7)
    const [cx, cy] = loopCentroid(loop)
    expect(cx).toBeCloseTo(4.0, 9)
    expect(cy).toBeCloseTo(5.0, 9)
  })

  it('computes area centroid of L-shape, not vertex average', () => {
    // L-shape (6x6 square minus a 4x4 corner), CCW. Area centroid is (2.2, 2.2);
    // the average of the vertices is (2.667, 2.667), so the two disagree clearly.
    // Flatface centroid must be the area centroid, not the average of boundary endpoints.
    const lShape: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [6, 0] },
      { kind: 'line', start: [6, 0], end: [6, 2] },
      { kind: 'line', start: [6, 2], end: [2, 2] },
      { kind: 'line', start: [2, 2], end: [2, 6] },
      { kind: 'line', start: [2, 6], end: [0, 6] },
      { kind: 'line', start: [0, 6], end: [0, 0] },
    ]
    const [cx, cy] = loopCentroid(lShape)
    expect(cx).toBeCloseTo(2.2, 7)
    expect(cy).toBeCloseTo(2.2, 7)
    // Must NOT be the old endpoint/vertex average (16/6 ≈ 2.667)
    expect(Math.abs(cx - 16 / 6)).toBeGreaterThan(0.1)
  })

  it('offsets half-disk centroid toward arc', () => {
    /** A half-disk's centroid is offset toward the arc by 4r/(3*pi), not at the
     *  diameter midpoint. This only resolves if arcs are sampled finely. */
    const r = 2.0
    const loop: LoopEdge[] = [
      { kind: 'line', start: [-r, 0], end: [r, 0] },
      { kind: 'arc', start: [r, 0], end: [-r, 0], center: [0, 0], radius: r, angle_start_deg: 0, angle_end_deg: 180, ccw: true },
    ]
    const [cx, cy] = loopCentroid(loop)
    const expectedCy = 4 * r / (3 * Math.PI)  // ~0.8488
    expect(cx).toBeCloseTo(0.0, 7)
    expect(cy).toBeCloseTo(expectedCy, 2)
    // The diameter midpoint (circle center) is y=0; the fix must move off it.
    expect(cy).toBeGreaterThan(0.5)
  })

  it('returns the first point for a degenerate (zero-area) collinear loop', () => {
    // Three collinear points have ~0 signed area, so the area-weighted centroid is
    // undefined; the helper falls back to the first vertex rather than dividing by 0.
    const loop: LoopEdge[] = [
      { kind: 'line', start: [5, 5] },
      { kind: 'line', start: [6, 5] },
      { kind: 'line', start: [7, 5] },
    ]
    expect(loopCentroid(loop)).toEqual([5, 5])
  })
})

describe('arcSamplePoints', () => {
  it('returns midpoint for 0 to 90 degree arc', () => {
    // midpoint of 0->90 deg arc at origin radius 1 is at 45 deg
    const pts = arcSamplePoints(arcEdge(0, 0, 1, 0, 90), 1)
    expect(pts).toHaveLength(1)
    expect(pts[0][0]).toBeCloseTo(Math.cos(Math.PI / 4), 9)
    expect(pts[0][1]).toBeCloseTo(Math.sin(Math.PI / 4), 9)
  })

  it('returns empty array for line edge', () => {
    const e: LoopEdge = { kind: 'line', start: [0, 0], end: [1, 0] }
    expect(arcSamplePoints(e, 1)).toEqual([])
  })

  it('returns empty array for arc without center', () => {
    const e: LoopEdge = { kind: 'arc', radius: 1.0 }
    expect(arcSamplePoints(e, 1)).toEqual([])
  })

  it('samples a clockwise arc the long way around (ccw=false swaps endpoints)', () => {
    // ccw=false swaps a0/a1 so 0->90 deg is traversed the long way; the single
    // midpoint lands at 225 deg (third quadrant), not the short-arc 45 deg.
    const pts = arcSamplePoints(arcEdge(0, 0, 1, 0, 90, false), 1)
    expect(pts).toHaveLength(1)
    expect(pts[0][0]).toBeCloseTo(Math.cos((5 * Math.PI) / 4), 9)
    expect(pts[0][1]).toBeCloseTo(Math.sin((5 * Math.PI) / 4), 9)
  })
})

describe('ellipseArcSamplePoints', () => {
  it('returns empty array for a non-ellipse_arc edge', () => {
    expect(ellipseArcSamplePoints({ kind: 'arc', center: [0, 0], radius: 1 }, 1)).toEqual([])
  })

  it('returns empty array for an ellipse_arc without center', () => {
    expect(ellipseArcSamplePoints({ kind: 'ellipse_arc', a: 4, b: 2 }, 1)).toEqual([])
  })

  it('samples a CCW elliptical arc interior point on the semi-axes', () => {
    // center origin, a=4 b=2, theta=0, 0->90 deg CCW: the midpoint sits at phi=45 deg.
    const e: LoopEdge = { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2, theta: 0, angle_start_deg: 0, angle_end_deg: 90, ccw: true }
    const pts = ellipseArcSamplePoints(e, 1)
    expect(pts).toHaveLength(1)
    expect(pts[0][0]).toBeCloseTo(4 * Math.cos(Math.PI / 4), 9)
    expect(pts[0][1]).toBeCloseTo(2 * Math.sin(Math.PI / 4), 9)
  })

  it('takes the long way for a CW elliptical arc (ccw=false unwraps backwards)', () => {
    // Same 0->90 deg span but CW: p1 -= 2pi, so the midpoint is at phi=-135 deg
    // (third quadrant), distinct from the CCW short-arc point.
    const e: LoopEdge = { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2, theta: 0, angle_start_deg: 0, angle_end_deg: 90, ccw: false }
    const pts = ellipseArcSamplePoints(e, 1)
    expect(pts).toHaveLength(1)
    expect(pts[0][0]).toBeLessThan(0)
    expect(pts[0][1]).toBeLessThan(0)
  })

  it('applies the theta rotation to the sampled points', () => {
    // theta=90 deg rotates local (ax, ay) by a quarter turn: with cr=0, sr=1 the
    // 45 deg sample maps to [center - ay, center + ax].
    const e: LoopEdge = { kind: 'ellipse_arc', center: [0, 0], a: 4, b: 2, theta: 90, angle_start_deg: 0, angle_end_deg: 90, ccw: true }
    const pts = ellipseArcSamplePoints(e, 1)
    const ax = 4 * Math.cos(Math.PI / 4)
    const ay = 2 * Math.sin(Math.PI / 4)
    expect(pts[0][0]).toBeCloseTo(-ay, 9)
    expect(pts[0][1]).toBeCloseTo(ax, 9)
  })
})

describe('loopPts', () => {
  it('default arc sampling produces start + one midpoint', () => {
    /** Default arc sampling (1) must still yield the single midpoint, preserving
     *  behaviour for loopSignedArea / pointInLoop. */
    const arc: LoopEdge = { kind: 'arc', start: [1, 0], center: [0, 0], radius: 1.0, angle_start_deg: 0, angle_end_deg: 90, ccw: true }
    const pts = loopPts([arc])  // default arc_samples=1
    // start + one interior (midpoint at 45 deg).
    expect(pts).toHaveLength(2)
    expect(pts[0]).toEqual([1, 0])
    expect(pts[1][0]).toBeCloseTo(Math.cos(Math.PI / 4))
    expect(pts[1][1]).toBeCloseTo(Math.sin(Math.PI / 4))
  })

  it('samples interior points along a spline edge (not just the chord)', () => {
    // Symmetric bulge up: the midpoint must sit above the start->end chord.
    const spline: LoopEdge = { kind: 'spline', start: [0, 0], end: [4, 0], c1: [1, 3], c2: [3, 3] }
    const pts = loopPts([spline], 3)  // start + 3 interior bezier samples
    expect(pts).toHaveLength(4)
    expect(pts[0]).toEqual([0, 0])
    expect(pts[2][1]).toBeGreaterThan(0)  // the curve bulges off the chord
  })

  it('densely samples a self-closing spline (start == end) as its own loop', () => {
    // A spline whose start coincides with its end is a standalone closed loop, so
    // loopPts must give it the dense (>=16) sampling, like a full ellipse.
    const closed: LoopEdge = { kind: 'spline', start: [0, 0], end: [0, 0], c1: [4, 4], c2: [-4, 4] }
    const pts = loopPts([closed])  // default arcSamples=1
    expect(pts.length).toBeGreaterThanOrEqual(16)
  })

  it('samples a full ellipse edge as a closed polygon', () => {
    const ell: LoopEdge = { kind: 'ellipse', center: [3, 1], a: 4, b: 2, theta: 0 }
    const pts = loopPts([ell])
    expect(pts.length).toBeGreaterThanOrEqual(16)
    // Extents track the semi-axes about the center.
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.max(...xs)).toBeCloseTo(7, 6)
    expect(Math.min(...xs)).toBeCloseTo(-1, 6)
    expect(Math.max(...ys)).toBeCloseTo(3, 6)
    expect(Math.min(...ys)).toBeCloseTo(-1, 6)
  })
})

describe('loopCentroid: curved boundaries', () => {
  it('a full ellipse centroid is its center, not [0,0]', () => {
    const ell: LoopEdge = { kind: 'ellipse', center: [3, 1], a: 4, b: 2, theta: 0 }
    const [cx, cy] = loopCentroid([ell])
    expect(cx).toBeCloseTo(3, 6)
    expect(cy).toBeCloseTo(1, 6)
  })

  it('a full ellipse signed area approaches pi*a*b (inscribed-polygon underestimate)', () => {
    const ell: LoopEdge = { kind: 'ellipse', center: [0, 0], a: 4, b: 2, theta: 0 }
    const exact = Math.PI * 4 * 2
    const area = Math.abs(loopSignedArea([ell]))
    // The inscribed 16-gon underestimates but must be within ~5% (enough for
    // hole containment / nesting decisions in classifyLoops).
    expect(area).toBeLessThan(exact)
    expect(area).toBeGreaterThan(exact * 0.95)
  })
})
