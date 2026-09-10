import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  pointTo3D,
  getIconUrl,
  p2w,
  sampleArc,
  sampleArcCCW,
  getEntityBounds,
} from '@/utils/geometry/sketchHelpers'
import type { Entity } from '@/types/cad'

// sketch_helpers is pure (THREE math + asset lookup, no DOM). The existing
// sketch_helpers.test.ts pins sampleEllipse / sampleBezier / ellipseAxisPoints
// and the spline/ellipse getEntityBounds arms. This file fills the rest:
// pointTo3D, getIconUrl, p2w, the two arc samplers, and the remaining
// getEntityBounds arms (line / circle / arc / point).

describe('pointTo3D', () => {
  it('lifts a finite 2D point onto the z=0 plane', () => {
    expect(pointTo3D([2, 3])).toEqual([2, 3, 0])
  })

  it('returns null when a coordinate is not finite', () => {
    expect(pointTo3D([NaN, 3])).toBeNull()
    expect(pointTo3D([2, Infinity])).toBeNull()
  })
})

describe('getIconUrl', () => {
  it('returns undefined for a kind with no icon mapping', () => {
    expect(getIconUrl('definitely-not-a-render-kind')).toBeUndefined()
  })

  it('resolves a bundled svg url for a mapped kind', () => {
    // symbol_ngon -> 'toolbar-ngon', and toolbar-ngon.svg exists in assets.
    const url = getIconUrl('symbol_ngon')
    expect(typeof url).toBe('string')
  })
})

describe('p2w (world units per pixel)', () => {
  it('inverts the zoom for an orthographic camera', () => {
    const cam = new THREE.OrthographicCamera()
    cam.zoom = 2
    expect(p2w(cam)).toBeCloseTo(0.5)
  })

  it('throws for a camera without an orthographic flag instead of returning 1', () => {
    expect(() => p2w({} as unknown as THREE.Camera)).toThrow(/orthographic/i)
  })
})

describe('sampleArc', () => {
  it('samples a closed full circle when start equals end angle', () => {
    const pts = sampleArc(0, 0, 1, 0, 0)
    expect(pts).toHaveLength(65)  // 64 steps + 1
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(1)
    // First and last coincide (the seam closes).
    expect(pts[0][0]).toBeCloseTo(pts[64][0])
    expect(pts[0][1]).toBeCloseTo(pts[64][1])
  })

  it('samples a 90deg arc from +x to +y', () => {
    const pts = sampleArc(0, 0, 1, 0, 90)
    expect(pts[0][0]).toBeCloseTo(1)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[pts.length - 1][0]).toBeCloseTo(0)
    expect(pts[pts.length - 1][1]).toBeCloseTo(1)
  })

  it('takes the short way (<=180deg) when the span exceeds a half turn', () => {
    // 0 -> 270 CCW is 270deg; sampleArc clamps to the -90deg short arc instead.
    const pts = sampleArc(0, 0, 1, 0, 270)
    const last = pts[pts.length - 1]
    expect(last[0]).toBeCloseTo(0)
    expect(last[1]).toBeCloseTo(-1)
  })

  it('returns an empty array on non-finite input', () => {
    expect(sampleArc(NaN, 0, 1, 0, 90)).toEqual([])
  })
})

describe('sampleArcCCW', () => {
  it('goes the long CCW way without clamping to a half turn', () => {
    const pts = sampleArcCCW(0, 0, 1, 0, 270)
    // It ends at 270deg ([0,-1]) but, unlike sampleArc, sweeps through 180deg.
    const last = pts[pts.length - 1]
    expect(last[0]).toBeCloseTo(0)
    expect(last[1]).toBeCloseTo(-1)
    const passesThrough180 = pts.some(([x, y]) => Math.abs(x - -1) < 1e-6 && Math.abs(y) < 1e-6)
    expect(passesThrough180).toBe(true)
  })

  it('treats coincident start/end as a full circle', () => {
    const pts = sampleArcCCW(0, 0, 1, 45, 45)
    expect(pts.length).toBe(65)
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(1)
  })

  it('returns an empty array on non-finite input', () => {
    expect(sampleArcCCW(0, 0, Infinity, 0, 90)).toEqual([])
  })
})

describe('getEntityBounds', () => {
  it('bounds a line by its endpoints', () => {
    const line: Entity = { start: [-1, 2], end: [4, -3] }
    expect(getEntityBounds(line)).toEqual({ minX: -1, maxX: 4, minY: -3, maxY: 2 })
  })

  it('bounds a circle by center +/- radius', () => {
    const circle: Entity = { center: [1, 1], radius: 3 }
    expect(getEntityBounds(circle)).toEqual({ minX: -2, maxX: 4, minY: -2, maxY: 4 })
  })

  it('bounds an arc using its endpoints and the four cardinal extents', () => {
    const arc: Entity = {
      center: [0, 0], radius: 2,
      angle_start: 0, angle_end: 90,
      start: [2, 0], end: [0, 2],
    }
    // The cardinal extents (+/-2 on each axis) dominate the two endpoints.
    expect(getEntityBounds(arc)).toEqual({ minX: -2, maxX: 2, minY: -2, maxY: 2 })
  })

  it('bounds a point entity to a zero-area box at its position', () => {
    const pt: Entity = { x: 7, y: -4 }
    expect(getEntityBounds(pt)).toEqual({ minX: 7, maxX: 7, minY: -4, maxY: -4 })
  })
})
