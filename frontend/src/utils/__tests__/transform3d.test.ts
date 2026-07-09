import { describe, it, expect } from 'vitest'
import type { Transform3D } from '@/types/cad'
import {
  composeTransforms,
  IDENTITY_TRANSFORM,
  invertTransform,
  makeTransform,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  relativeTransform,
  rotateTransformAboutPoint,
  rotateVector,
  translateTransform,
  transformsEqual,
  type Quat,
  type Vec3,
} from '@/utils/transform3d'

const X: Vec3 = [1, 0, 0]
const Y: Vec3 = [0, 1, 0]
const Z: Vec3 = [0, 0, 1]
const HALF_PI = Math.PI / 2

function expectVecClose(a: Vec3, b: Vec3) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 9)
}

describe('quaternion primitives', () => {
  it('quatFromAxisAngle builds a unit quaternion; a zero axis yields identity', () => {
    const q = quatFromAxisAngle([0, 0, 2], HALF_PI)  // non-unit axis is normalized
    expect(Math.hypot(...q)).toBeCloseTo(1, 12)
    expect(q[2]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(quatFromAxisAngle([0, 0, 0], 1)).toEqual([0, 0, 0, 1])
  })

  it('quatNormalize falls back to identity on a degenerate quaternion', () => {
    expect(quatNormalize([0, 0, 0, 0])).toEqual([0, 0, 0, 1])
    expect(quatNormalize([NaN, 0, 0, 1])).toEqual([0, 0, 0, 1])
  })

  it('rotateVector turns +X into +Y under a +90 degrees spin about Z', () => {
    expectVecClose(rotateVector(quatFromAxisAngle(Z, HALF_PI), X), Y)
  })

  it('quatMultiply applies the right-hand operand first', () => {
    const rz = quatFromAxisAngle(Z, HALF_PI)
    const rx = quatFromAxisAngle(X, HALF_PI)
    // rz ∘ rx sends +Y -> +Z (by rx) -> +Z (Z is invariant under rz)
    expectVecClose(rotateVector(quatMultiply(rz, rx), Y), Z)
  })

  it('two 90-degree spins about the same axis compose to a 180-degree spin', () => {
    const half = quatFromAxisAngle(Z, HALF_PI)
    const full: Quat = quatMultiply(half, half)
    expectVecClose(rotateVector(full, X), [-1, 0, 0])
  })
})

describe('translateTransform', () => {
  it('adds the world delta and leaves the orientation untouched', () => {
    const seed = makeTransform([1, 2, 3], quatFromAxisAngle(Z, HALF_PI))
    const moved = translateTransform(seed, [10, 0, -1])
    expect([moved.tx, moved.ty, moved.tz]).toEqual([11, 2, 2])
    expect([moved.qx, moved.qy, moved.qz, moved.qw]).toEqual([seed.qx, seed.qy, seed.qz, seed.qw])
  })
})

describe('rotateTransformAboutPoint', () => {
  it('spins in place about the part origin when the pivot is the part origin', () => {
    const seed = makeTransform([5, 0, 0], [0, 0, 0, 1])
    const spun = rotateTransformAboutPoint(seed, Z, HALF_PI, [5, 0, 0])
    expect([spun.tx, spun.ty, spun.tz]).toEqual([5, 0, 0])  // pivot is fixed
    expectVecClose(rotateVector([spun.qx, spun.qy, spun.qz, spun.qw], X), Y)
  })

  it('orbits the translation around a pivot away from the part origin', () => {
    const seed = makeTransform([1, 0, 0], [0, 0, 0, 1])
    const spun = rotateTransformAboutPoint(seed, Z, HALF_PI, [0, 0, 0])
    expect(spun.tx).toBeCloseTo(0, 9)
    expect(spun.ty).toBeCloseTo(1, 9)
  })

  it('composes with the existing quaternion rather than replacing it', () => {
    // A part already turned 90 degrees about Z, spun another 90 about Z, faces -X.
    const seed = makeTransform([0, 0, 0], quatFromAxisAngle(Z, HALF_PI))
    const spun = rotateTransformAboutPoint(seed, Z, HALF_PI, [0, 0, 0])
    expectVecClose(rotateVector([spun.qx, spun.qy, spun.qz, spun.qw], X), [-1, 0, 0])
  })

  it('applies the rotation in world space (pre-multiply), not in part space', () => {
    // Part is rolled 90 degrees about X, so its local +Y points at world +Z.
    const seed = makeTransform([0, 0, 0], quatFromAxisAngle(X, HALF_PI))
    // A world-space spin about Z must move the part's local +X to world +Y,
    // which a part-space (post-multiplied) spin would not do.
    const spun = rotateTransformAboutPoint(seed, Z, HALF_PI, [0, 0, 0])
    expectVecClose(rotateVector([spun.qx, spun.qy, spun.qz, spun.qw], X), Y)
  })

  it('keeps the quaternion unit-norm across repeated rotations', () => {
    let t = makeTransform([0, 0, 0], [0, 0, 0, 1])
    for (let i = 0; i < 200; i++) t = rotateTransformAboutPoint(t, [1, 1, 1], 0.3, [0, 0, 0])
    expect(Math.hypot(t.qx, t.qy, t.qz, t.qw)).toBeCloseTo(1, 9)
  })
})

describe('transformsEqual', () => {
  it('is exact within tolerance and rejects a moved transform', () => {
    expect(transformsEqual(IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM })).toBe(true)
    expect(transformsEqual(IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, tx: 1e-12 })).toBe(true)
    expect(transformsEqual(IDENTITY_TRANSFORM, { ...IDENTITY_TRANSFORM, tx: 0.5 })).toBe(false)
  })
})

describe('compose / invert', () => {
  const placed: Transform3D = makeTransform([1, 2, 3], quatFromAxisAngle([1, 2, 3], 0.7))

  // A transform and its inverse are only meaningful through the points they map.
  function applyTo(t: Transform3D, p: Vec3): Vec3 {
    const r = rotateVector([t.qx, t.qy, t.qz, t.qw], p)
    return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz]
  }

  it('invert undoes the transform for any point', () => {
    const p: Vec3 = [4, -5, 6]
    expectVecClose(applyTo(invertTransform(placed), applyTo(placed, p)), p)
    expect(transformsEqual(composeTransforms(placed, invertTransform(placed)), IDENTITY_TRANSFORM, 1e-6)).toBe(true)
  })

  it('compose applies the right operand first', () => {
    const spin = makeTransform([0, 0, 0], quatFromAxisAngle(Z, HALF_PI))
    const shift = makeTransform([1, 0, 0], [0, 0, 0, 1])
    // spin ∘ shift: move to +X, then the spin swings it round to +Y.
    expectVecClose(applyTo(composeTransforms(spin, shift), [0, 0, 0]), Y)
    // shift ∘ spin: spinning the origin is a no-op, so only the shift shows.
    expectVecClose(applyTo(composeTransforms(shift, spin), [0, 0, 0]), X)
  })

  it('relativeTransform carries base onto current', () => {
    const current: Transform3D = makeTransform([-2, 7, 0], quatFromAxisAngle(X, 1.1))
    const delta = relativeTransform(current, placed)
    // Applying the delta on top of a point already placed by `base` lands the
    // point where `current` would have placed it: exactly what the viewport does
    // with vertices baked at the solved pose.
    const p: Vec3 = [0.5, -1, 2]
    expectVecClose(applyTo(delta, applyTo(placed, p)), applyTo(current, p))
  })

  it('is identity when current equals base (a part at rest gets no offset)', () => {
    expect(transformsEqual(relativeTransform(placed, placed), IDENTITY_TRANSFORM, 1e-6)).toBe(true)
  })
})
