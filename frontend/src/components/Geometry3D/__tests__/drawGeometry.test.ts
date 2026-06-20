import { describe, it, expect } from 'vitest'
import {
  circumcircle,
  arcAnglesFromRadiusPoint,
  ngonPolyline,
  computePreviewPts,
  sketchExtent,
  findEntitiesAtPoint,
} from '@/components/Geometry3D/drawGeometry'
import type { Sketch } from '@/types/cad'

// drawGeometry is pure planar geometry (no Three.js / no DOM). drawLogic.test.ts
// already exercises the spline/ellipse/ngon preview branches; this file pins the
// remaining helpers: circumcircle, arc-angle disambiguation, ngon vertices, the
// simpler preview tools, and the two sketch-scan utilities (sketchExtent,
// findEntitiesAtPoint) which had zero coverage.

describe('circumcircle', () => {
  it('finds the circle through three points on the unit circle', () => {
    const c = circumcircle([1, 0], [0, 1], [-1, 0])
    expect(c).not.toBeNull()
    expect(c!.cx).toBeCloseTo(0)
    expect(c!.cy).toBeCloseTo(0)
    expect(c!.r).toBeCloseTo(1)
  })

  it('returns null for collinear points (degenerate determinant)', () => {
    expect(circumcircle([0, 0], [1, 1], [2, 2])).toBeNull()
  })
})

describe('arcAnglesFromRadiusPoint', () => {
  // Start at 0deg, end at 90deg about the origin; CCW span is the first quadrant.
  it('keeps [start, end] when the radius point lies inside the CCW span', () => {
    const [a, b] = arcAnglesFromRadiusPoint(0, 0, [1, 0], [0, 1], [1, 1]) // 45deg, inside
    expect(a).toBeCloseTo(0)
    expect(b).toBeCloseTo(90)
  })

  it('swaps to [end, start] when the radius point lies outside the CCW span', () => {
    const [a, b] = arcAnglesFromRadiusPoint(0, 0, [1, 0], [0, 1], [1, -1]) // -45deg, outside
    expect(a).toBeCloseTo(90)
    expect(b).toBeCloseTo(0)
  })
})

describe('ngonPolyline', () => {
  it('starts at the corner and closes the loop exactly', () => {
    const poly = ngonPolyline([0, 0], [1, 0], 4)
    expect(poly).toHaveLength(5)  // 4 vertices + repeated seam
    expect(poly[0]).toEqual([1, 0, 0])
    expect(poly[4]).toEqual(poly[0])  // exact close, no float drift
    // Square: the second vertex is a quarter turn CCW from the corner.
    expect(poly[1][0]).toBeCloseTo(0)
    expect(poly[1][1]).toBeCloseTo(1)
  })

  it('clamps sides to a minimum of 3 and floors fractional counts', () => {
    expect(ngonPolyline([0, 0], [1, 0], 2)).toHaveLength(4)    // 3 + close
    expect(ngonPolyline([0, 0], [1, 0], 5.9)).toHaveLength(6)  // floor(5.9)=5, +close
  })

  it('places every vertex on the circumcircle through the corner', () => {
    const poly = ngonPolyline([2, 3], [5, 3], 6)  // radius 3
    for (const [x, y] of poly) {
      expect(Math.hypot(x - 2, y - 3)).toBeCloseTo(3)
    }
  })
})

describe('computePreviewPts', () => {
  it('line: previews a segment from the placed point to the cursor', () => {
    expect(computePreviewPts('line', [[0, 0]], [2, 3])).toEqual([[0, 0, 0], [2, 3, 0]])
  })

  it('circle: previews a full sampled circle through the cursor radius', () => {
    const pts = computePreviewPts('circle', [[0, 0]], [3, 0])!
    expect(pts.length).toBeGreaterThan(8)
    // Every sample sits on the radius-3 circle about the centre.
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(3)
  })

  it('arc: falls back to a straight segment when the three points are collinear', () => {
    expect(computePreviewPts('arc', [[0, 0], [2, 0]], [1, 0])).toEqual([[0, 0, 0], [2, 0, 0]])
  })

  it('arc: previews a segment to the cursor with only one point placed', () => {
    expect(computePreviewPts('arc', [[0, 0]], [1, 1])).toEqual([[0, 0, 0], [1, 1, 0]])
  })

  it('arc: previews a curved arc when the three points are not collinear', () => {
    const pts = computePreviewPts('arc', [[1, 0], [0, 1]], [-1, 0])!
    expect(pts.length).toBeGreaterThan(2)
  })

  it('rect: previews a closed rectangle from corner to cursor', () => {
    expect(computePreviewPts('rect', [[0, 0]], [2, 3])).toEqual([
      [0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 0],
    ])
  })

  it('center_rect: previews a rectangle centred on the placed point', () => {
    expect(computePreviewPts('center_rect', [[0, 0]], [2, 3])).toEqual([
      [-2, -3, 0], [2, -3, 0], [2, 3, 0], [-2, 3, 0], [-2, -3, 0],
    ])
  })

  it('returns null when there is no hover or the tool is unknown', () => {
    expect(computePreviewPts('line', [[0, 0]], null)).toBeNull()
    expect(computePreviewPts('bogus', [[0, 0]], [1, 1])).toBeNull()
    expect(computePreviewPts('line', [], [1, 1])).toBeNull()
  })
})

describe('sketchExtent', () => {
  it('returns the larger of the width/height span across all entities', () => {
    const sketch: Sketch = {
      l1: { start: [0, 0], end: [3, 1] },
    }
    expect(sketchExtent(sketch)).toBeCloseTo(3)
  })

  it('floors the extent at 0.01 for a degenerate (single-point) sketch', () => {
    const sketch: Sketch = { p1: { x: 5, y: 5 } }
    expect(sketchExtent(sketch)).toBeCloseTo(0.01)
  })

  it('returns 1 for an empty sketch (no finite bounds)', () => {
    expect(sketchExtent({})).toBe(1)
  })
})

describe('findEntitiesAtPoint', () => {
  const sketch: Sketch = {
    line1: { start: [0, 0], end: [10, 0] },
    spline1: { p1: [0, 0], p2: [1, 5], p3: [4, 5], p4: [5, 0] },
    point1: { x: 5, y: 0 },
    circle1: { center: [0, 0], radius: 2 },
  }

  it('matches a line by either endpoint', () => {
    expect(findEntitiesAtPoint(sketch, [10, 0])).toContain('line1')
  })

  it('matches a spline by its on-curve endpoints (p1 / p4)', () => {
    expect(findEntitiesAtPoint(sketch, [5, 0])).toContain('spline1')  // p4
  })

  it('matches a point entity by its x/y', () => {
    expect(findEntitiesAtPoint(sketch, [5, 0])).toContain('point1')
  })

  it('matches a circle by its centre', () => {
    // The origin is shared by line1.start, spline1.p1 and circle1.center.
    const ids = findEntitiesAtPoint(sketch, [0, 0])
    expect(ids).toEqual(expect.arrayContaining(['line1', 'spline1', 'circle1']))
  })

  it('returns an empty list when nothing is within eps', () => {
    expect(findEntitiesAtPoint(sketch, [99, 99])).toEqual([])
  })

  it('respects the eps tolerance', () => {
    expect(findEntitiesAtPoint(sketch, [10.00005, 0], 1e-4)).toContain('line1')
    expect(findEntitiesAtPoint(sketch, [10.5, 0], 1e-4)).not.toContain('line1')
  })
})
