import { describe, it, expect } from 'vitest'
import {
  projectWorldToSketch,
  builtinPlaneTransform,
  planeTransformNormal,
  buildBodySnapSketch,
  BODY_SNAP_FEAT_PREFIX,
} from '@/components/Geometry3D/bodySnapProjection'
import type { PlaneTransform } from '@/types/cad'

const FRONT_PT = builtinPlaneTransform('@builtin_plane_front')!
const TOP_PT   = builtinPlaneTransform('@builtin_plane_top')!
const RIGHT_PT = builtinPlaneTransform('@builtin_plane_right')!

describe('BODY_SNAP_FEAT_PREFIX', () => {
  it('is a non-empty string sentinel', () => {
    expect(typeof BODY_SNAP_FEAT_PREFIX).toBe('string')
    expect(BODY_SNAP_FEAT_PREFIX.length).toBeGreaterThan(0)
  })
})

describe('builtinPlaneTransform', () => {
  it('returns front plane transform with @ prefix', () => {
    expect(FRONT_PT).not.toBeNull()
  })

  it('returns front plane transform without @ prefix', () => {
    expect(builtinPlaneTransform('builtin_plane_front')).not.toBeNull()
  })

  it('returns null for unknown plane', () => {
    expect(builtinPlaneTransform('unknown_plane')).toBeNull()
  })
})

describe('planeTransformNormal', () => {
  it('reads the builtin plane normals as the third rotation row', () => {
    expect(planeTransformNormal(FRONT_PT)).toEqual([0, 0, 1])
    expect(planeTransformNormal(TOP_PT)).toEqual([0, 1, 0])
    expect(planeTransformNormal(RIGHT_PT)).toEqual([1, 0, 0])
  })

  it('reads the normal of an arbitrary rotation', () => {
    const t: PlaneTransform = { rotation: [1, 0, 0,  0, 0, 1,  0, -1, 0], origin: [4, 5, 6] }
    expect(planeTransformNormal(t)).toEqual([0, -1, 0])
  })
})

describe('projectWorldToSketch -- front plane (identity)', () => {
  it('maps world XY to sketch XY', () => {
    const [x, y] = projectWorldToSketch([3, 4, 0], FRONT_PT)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(4)
  })

  it('ignores world Z on the front plane', () => {
    const [x, y] = projectWorldToSketch([3, 4, 99], FRONT_PT)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(4)
  })

  it('applies origin offset', () => {
    const t: PlaneTransform = { rotation: [1, 0, 0,  0, 1, 0,  0, 0, 1], origin: [5, 10, 0] }
    const [x, y] = projectWorldToSketch([8, 15, 0], t)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(5)
  })
})

describe('projectWorldToSketch -- top plane', () => {
  it('maps world X to sketch X', () => {
    const [x] = projectWorldToSketch([7, 0, 0], TOP_PT)
    expect(x).toBeCloseTo(7)
  })

  it('maps world -Z to sketch Y', () => {
    const [, y] = projectWorldToSketch([0, 0, -5], TOP_PT)
    expect(y).toBeCloseTo(5)
  })

  it('ignores world Y on the top plane', () => {
    const [x, y] = projectWorldToSketch([3, 99, -4], TOP_PT)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(4)
  })
})

describe('projectWorldToSketch -- right plane', () => {
  it('maps world -Z to sketch X', () => {
    const [x] = projectWorldToSketch([0, 0, -6], RIGHT_PT)
    expect(x).toBeCloseTo(6)
  })

  it('maps world Y to sketch Y', () => {
    const [, y] = projectWorldToSketch([0, 8, 0], RIGHT_PT)
    expect(y).toBeCloseTo(8)
  })

  it('ignores world X on the right plane', () => {
    const [x, y] = projectWorldToSketch([99, 8, -6], RIGHT_PT)
    expect(x).toBeCloseTo(6)
    expect(y).toBeCloseTo(8)
  })
})

describe('buildBodySnapSketch', () => {
  it('returns empty sketch when no vertices or edges', () => {
    const s = buildBodySnapSketch(undefined, undefined, FRONT_PT)
    expect(Object.keys(s)).toHaveLength(0)
  })

  it('creates PointEntity for each vertex', () => {
    const s = buildBodySnapSketch([[1, 2, 0], [3, 4, 0]], undefined, FRONT_PT)
    const entries = Object.values(s)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ x: 1, y: 2 })
    expect(entries[1]).toMatchObject({ x: 3, y: 4 })
  })

  it('creates LineSegment for line edges', () => {
    const s = buildBodySnapSketch(undefined, [
      { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
    ], FRONT_PT)
    const entries = Object.values(s)
    expect(entries).toHaveLength(1)
    const line = entries[0] as { start: [number, number]; end: [number, number] }
    expect(line.start).toEqual([0, 0])
    expect(line.end).toEqual([10, 0])
  })

  it('creates PointEntity for arc/circle center', () => {
    const s = buildBodySnapSketch(undefined, [
      { kind: 'arc', center: [5, 3, 0], radius: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI },
    ], FRONT_PT)
    const entries = Object.values(s)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ x: 5, y: 3 })
  })

  it('creates PointEntity entries for spline endpoints', () => {
    const s = buildBodySnapSketch(undefined, [
      { kind: 'spline', points: [[0, 0, 0], [5, 2, 0], [10, 0, 0]] },
    ], FRONT_PT)
    const entries = Object.values(s)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ x: 0, y: 0 })
    expect(entries[1]).toMatchObject({ x: 10, y: 0 })
  })

  it('projects vertices using top plane transform', () => {
    // On the top plane: world (1,0,-2) → sketch (1, 2)
    const s = buildBodySnapSketch([[1, 0, -2]], undefined, TOP_PT)
    const entries = Object.values(s)
    expect(entries[0]).toMatchObject({ x: 1, y: 2 })
  })

  it('mixes vertices and edges with unique entity IDs', () => {
    const s = buildBodySnapSketch(
      [[0, 0, 0]],
      [{ kind: 'line', start: [1, 0, 0], end: [2, 0, 0] }],
      FRONT_PT,
    )
    const keys = Object.keys(s)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)  // all IDs are unique
  })
})
