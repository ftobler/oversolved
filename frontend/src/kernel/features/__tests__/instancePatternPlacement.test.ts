// The instance pattern's placement law, pure: the minimal rotation, the
// antiparallel rule, the reverse-normal flip and the source-slot skip. The real
// kernel test (instancePatternReal.test.ts) reads the same law through copies.

import { describe, it, expect } from 'vitest'
import { rotateVector, quatNormalize, quatToAxisAngle, transformTranslation, transformQuat } from '@/utils/transform3d'
import {
  minimalRotation, perpendicularTo, placeOnTarget, placeOnTargets,
  type PlacementTarget, type Vec3,
} from '../instancePatternPlacement'

function expectVec(actual: readonly number[], expected: readonly number[], digits = 9): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits))
}

function target(point: Vec3, normal: Vec3 | null, key = 'p'): PlacementTarget {
  return { key, label: key, point, normal }
}

describe('minimalRotation', () => {
  it('is the identity for equal directions', () => {
    const q = minimalRotation([0, 0, 1], [0, 0, 1])
    expect(q[3]).toBeCloseTo(1, 12)
    expect(q.slice(0, 3).map(Math.abs)).toEqual([0, 0, 0])
  })

  it('carries the source normal onto the target normal', () => {
    const q = minimalRotation([0, 0, 1], [1, 0, 0])
    expectVec(rotateVector(q, [0, 0, 1]), [1, 0, 0])
    // The minimal rotation is a quarter turn about +Y, not a quarter about -Y.
    const { axis, angle } = quatToAxisAngle(q)
    expectVec(axis, [0, 1, 0])
    expect(angle).toBeCloseTo(Math.PI / 2, 9)
  })

  it('turns antiparallel normals 180 degrees about the source x axis', () => {
    const q = minimalRotation([0, 0, 1], [0, 0, -1], [1, 0, 0])
    const { axis, angle } = quatToAxisAngle(q)
    expectVec(axis, [1, 0, 0])
    expect(angle).toBeCloseTo(Math.PI, 9)
    expectVec(rotateVector(q, [0, 0, 1]), [0, 0, -1])
    // Deterministic: the same input gives the same quaternion.
    expect(quatNormalize(q)).toEqual(quatNormalize(minimalRotation([0, 0, 1], [0, 0, -1], [1, 0, 0])))
  })

  it('uses a deterministic perpendicular when no source x axis is given', () => {
    const x = perpendicularTo([0, 0, 1])
    expect(Math.abs(x[2])).toBeLessThan(1e-12)
    const q = minimalRotation([0, 0, 1], [0, 0, -1])
    expectVec(rotateVector(q, [0, 0, 1]), [0, 0, -1])
  })
})

describe('placeOnTarget', () => {
  it('is a pure translation for a copy aligned with the source normal', () => {
    const t = placeOnTarget([1, 2, 3], [0, 0, 1], null, target([10, 20, 30], [0, 0, 1]), 'normal', false)
    expectVec(transformTranslation(t), [9, 18, 27])
    expect(transformQuat(t)[3]).toBeCloseTo(1, 12)
  })

  it('turns a copy onto a side target and lands the reference on the target', () => {
    const t = placeOnTarget([0, 0, 0], [0, 0, 1], null, target([5, 0, 0], [1, 0, 0]), 'normal', false)
    expectVec(rotateVector(transformQuat(t), [0, 0, 1]), [1, 0, 0])
    expectVec(transformTranslation(t), [5, 0, 0])
  })

  it('moves a target without a normal without turning it', () => {
    const t = placeOnTarget([0, 0, 0], [0, 0, 1], null, target([3, 4, 5], null), 'normal', false)
    expect(transformQuat(t)[3]).toBeCloseTo(1, 12)
    expectVec(transformTranslation(t), [3, 4, 5])
  })

  it('ignores every normal under fixed', () => {
    const withNormal = placeOnTarget([0, 0, 0], [0, 0, 1], null, target([5, 0, 0], [1, 0, 0]), 'fixed', false)
    const withoutNormal = placeOnTarget([0, 0, 0], null, null, target([5, 0, 0], null), 'fixed', false)
    expectVal(withNormal, withoutNormal)
  })

  it('flips the target normal under reverse_normal, not the source', () => {
    const t = placeOnTarget([0, 0, 0], [0, 0, 1], null, target([0, 0, 5], [0, 0, 1]), 'normal', true)
    const { angle } = quatToAxisAngle(transformQuat(t))
    expect(angle).toBeCloseTo(Math.PI, 9)
  })

  it('translates every copy when no source normal exists', () => {
    const t = placeOnTarget([0, 0, 0], null, null, target([5, 0, 0], [1, 0, 0]), 'normal', false)
    expect(transformQuat(t)[3]).toBeCloseTo(1, 12)
    expectVec(transformTranslation(t), [5, 0, 0])
  })
})

function expectVal(a: ReturnType<typeof placeOnTarget>, b: ReturnType<typeof placeOnTarget>): void {
  expect(transformQuat(a)).toEqual(transformQuat(b))
  expectVec(transformTranslation(a), transformTranslation(b))
}

describe('placeOnTargets', () => {
  it('leaves the source slot out quietly and keeps every other copy', () => {
    const result = placeOnTargets({
      reference: [0, 0, 0],
      sourceNormal: [0, 0, 1],
      targets: [
        target([0, 0, 0], [0, 0, 1], 'P1'),
        target([10, 0, 0], [0, 0, 1], 'P2'),
        target([0, 10, 0], [0, 0, 1], 'P3'),
      ],
      orientation: 'normal',
      reverseNormal: false,
    })
    expect(result.sourceSlots).toEqual([1])
    expect(result.placements.map((p) => p.key)).toEqual(['P2', 'P3'])
  })

  it('keeps a target the topology tolerance treats as a different slot', () => {
    const result = placeOnTargets({
      reference: [0, 0, 0],
      sourceNormal: null,
      targets: [target([0.01, 0, 0], null, 'P1')],
      orientation: 'fixed',
      reverseNormal: false,
    })
    expect(result.sourceSlots).toEqual([])
    expect(result.placements).toHaveLength(1)
  })
})
