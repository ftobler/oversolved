// Stage 6f: the ray math behind the assembly viewport's pointer surface.

import { describe, it, expect } from 'vitest'
import {
  closestParamOnAxis,
  intersectRayPlane,
  normalize,
  signedAngleAbout,
  unwrapAngle,
  type Ray,
} from '@/utils/gizmoMath'

const ray = (origin: [number, number, number], direction: [number, number, number]): Ray => ({ origin, direction })

describe('intersectRayPlane', () => {
  it('hits the plane the drag runs in', () => {
    const p = intersectRayPlane(ray([2, 3, 10], [0, 0, -1]), [0, 0, 4], [0, 0, 1])
    expect(p).toEqual([2, 3, 4])
  })

  it('hits behind the ray origin too (a plane is two-sided for a drag)', () => {
    const p = intersectRayPlane(ray([0, 0, 0], [0, 0, -1]), [0, 0, 5], [0, 0, 1])
    expect(p![2]).toBeCloseTo(5, 9)
  })

  it('returns null when the ray runs parallel to the plane', () => {
    expect(intersectRayPlane(ray([0, 0, 1], [1, 0, 0]), [0, 0, 0], [0, 0, 1])).toBeNull()
  })

  it('returns null for a degenerate plane normal', () => {
    expect(intersectRayPlane(ray([0, 0, 1], [0, 0, -1]), [0, 0, 0], [0, 0, 0])).toBeNull()
  })
})

describe('closestParamOnAxis', () => {
  it('measures the slide distance along the axis in world units', () => {
    // Ray shot down at x = 5 onto the x-axis.
    expect(closestParamOnAxis(ray([5, 1, 0], [0, -1, 0]), [0, 0, 0], [1, 0, 0])).toBeCloseTo(5, 9)
  })

  it('is measured from the axis point, not the world origin', () => {
    expect(closestParamOnAxis(ray([5, 1, 0], [0, -1, 0]), [2, 0, 0], [1, 0, 0])).toBeCloseTo(3, 9)
  })

  it('is independent of the axis vector length', () => {
    const long = closestParamOnAxis(ray([5, 1, 0], [0, -1, 0]), [0, 0, 0], [7, 0, 0])
    expect(long).toBeCloseTo(5, 9)
  })

  it('returns null when the ray is parallel to the axis (no slide is readable)', () => {
    expect(closestParamOnAxis(ray([0, 1, 0], [1, 0, 0]), [0, 0, 0], [1, 0, 0])).toBeNull()
  })
})

describe('signedAngleAbout', () => {
  it('is right-handed about the axis', () => {
    expect(signedAngleAbout([0, 0, 1], [1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 9)
    expect(signedAngleAbout([0, 0, 1], [0, 1, 0], [1, 0, 0])).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('ignores the components along the axis', () => {
    expect(signedAngleAbout([0, 0, 1], [1, 0, 9], [0, 1, -4])).toBeCloseTo(Math.PI / 2, 9)
  })

  it('is zero when an arm collapses onto the axis', () => {
    expect(signedAngleAbout([0, 0, 1], [0, 0, 3], [0, 1, 0])).toBe(0)
  })
})

describe('unwrapAngle', () => {
  const deg = (d: number) => d * Math.PI / 180

  it('leaves an angle alone when it already continues the previous one', () => {
    expect(unwrapAngle(deg(80), deg(70))).toBeCloseTo(deg(80), 9)
    expect(unwrapAngle(deg(-80), deg(-70))).toBeCloseTo(deg(-80), 9)
  })

  it('continues past a half turn instead of flipping sign', () => {
    // What atan2 reports as -170 after a 100 degree frame is really 190.
    expect(unwrapAngle(deg(-170), deg(100))).toBeCloseTo(deg(190), 9)
  })

  it('accumulates over full turns', () => {
    expect(unwrapAngle(deg(40), deg(330))).toBeCloseTo(deg(400), 9)
    expect(unwrapAngle(deg(-40), deg(-330))).toBeCloseTo(deg(-400), 9)
  })

  it('picks the nearer continuation, so a backward step stays backward', () => {
    expect(unwrapAngle(deg(170), deg(190))).toBeCloseTo(deg(170), 9)
  })
})

describe('normalize', () => {
  it('rejects a zero vector rather than emitting NaN', () => {
    expect(normalize([0, 0, 0])).toBeNull()
    expect(normalize([0, 3, 0])).toEqual([0, 1, 0])
  })
})
