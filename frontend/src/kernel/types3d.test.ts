import { describe, it, expect } from 'vitest'
import {
  emptyBrepDiff,
  projectWorldToFrame,
  normalToFrame,
  frameFromPlaneTransform,
  frameToPlaneTransform,
  type Frame3D,
} from './types3d'

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('emptyBrepDiff', () => {
  it('returns every classification list empty', () => {
    const d = emptyBrepDiff()
    expect(d.new_faces).toEqual([])
    expect(d.inherited_faces).toEqual([])
    expect(d.new_edges).toEqual([])
    expect(d.inherited_edges).toEqual([])
    expect(d.modified_input_faces).toEqual([])
    expect(d.deleted_input_faces).toEqual([])
    expect(d.modified_input_edges).toEqual([])
    expect(d.deleted_input_edges).toEqual([])
  })

  it('returns a fresh object and fresh lists on every call', () => {
    const a = emptyBrepDiff()
    const b = emptyBrepDiff()
    expect(a).not.toBe(b)
    expect(a.new_faces).not.toBe(b.new_faces)
  })
})

describe('normalToFrame', () => {
  // For a unit normal the cross-product fallback is mathematically unreachable;
  // exercise both the |nz| >= 0.9 helper-axis branch and the |nz| < 0.9 branch
  // and assert the result is an orthonormal basis of the plane.
  for (const normal of [[0, 0, 1], [1, 0, 0]] as [number, number, number][]) {
    it(`returns an orthonormal in-plane basis for normal ${JSON.stringify(normal)}`, () => {
      const { x_axis, y_axis } = normalToFrame(normal)
      expect(dot(x_axis, x_axis)).toBeCloseTo(1)
      expect(dot(y_axis, y_axis)).toBeCloseTo(1)
      expect(dot(x_axis, y_axis)).toBeCloseTo(0)
      expect(dot(x_axis, normal)).toBeCloseTo(0)
      expect(dot(y_axis, normal)).toBeCloseTo(0)
    })
  }

  it('falls back to x_axis=[1,0,0] when the normal is degenerate (zero vector)', () => {
    // A zero normal makes every cross product vanish (mag <= 1e-12), so the
    // defensive else branch supplies a deterministic x_axis rather than NaNs.
    expect(normalToFrame([0, 0, 0])).toEqual({ x_axis: [1, 0, 0], y_axis: [0, 0, 0] })
  })
})

describe('frameFromPlaneTransform / frameToPlaneTransform', () => {
  // A plane transform packs the three basis vectors into a flat 9-element
  // rotation row-major (x_axis, y_axis, normal); the frame splits it back out.
  const pt = { rotation: [1, 2, 3, 4, 5, 6, 7, 8, 9], origin: [10, 20, 30] }

  it('splits the rotation rows into x_axis / y_axis / normal', () => {
    expect(frameFromPlaneTransform(pt)).toEqual({
      origin: [10, 20, 30],
      x_axis: [1, 2, 3],
      y_axis: [4, 5, 6],
      normal: [7, 8, 9],
    })
  })

  it('round-trips through frameToPlaneTransform', () => {
    expect(frameToPlaneTransform(frameFromPlaneTransform(pt))).toEqual(pt)
  })
})

describe('projectWorldToFrame', () => {
  const builtinTop: Frame3D = {
    // Rx(-90deg): local x -> world x, local y -> world -z, normal -> world y.
    origin: [0, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 0, -1],
    normal: [0, 1, 0],
  }

  it('maps the document origin to [0,0] on a plane through the global origin', () => {
    expect(projectWorldToFrame([0, 0, 0], builtinTop)).toEqual([0, 0])
  })

  it('returns nonzero local coords for the origin on an offset plane', () => {
    // Same axes, but the plane origin sits at world (5, 10, -2).
    const offset: Frame3D = { ...builtinTop, origin: [5, 10, -2] }
    // d = (0,0,0) - (5,10,-2) = (-5,-10,2)
    // local_x = d . x_axis = -5
    // local_y = d . y_axis = d . (0,0,-1) = -2
    expect(projectWorldToFrame([0, 0, 0], offset)).toEqual([-5, -2])
  })

  it('projects an off-plane point to the foot of its perpendicular', () => {
    // The world point's component along the normal is discarded.
    const frame: Frame3D = {
      origin: [0, 0, 0],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
      normal: [0, 0, 1],
    }
    expect(projectWorldToFrame([3, 4, 99], frame)).toEqual([3, 4])
  })
})
