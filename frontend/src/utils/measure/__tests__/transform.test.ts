import { describe, it, expect } from 'vitest'
import type { Transform3D } from '@/types/cad'
import { makeTransform, quatFromAxisAngle } from '@/utils/transform3d'
import { transformPrimitive } from '@/utils/measure/transform'
import type { Primitive } from '@/utils/measure/primitives'

// A quarter turn about Z, then a 10 mm slide along X: a point (1, 0, 0) lands on
// (10, 1, 0) and a direction (1, 0, 0) turns to (0, 1, 0) with no translation.
const pose: Transform3D = makeTransform([10, 0, 0], quatFromAxisAngle([0, 0, 1], Math.PI / 2))

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9)
  expect(actual[1]).toBeCloseTo(expected[1], 9)
  expect(actual[2]).toBeCloseTo(expected[2], 9)
}

const cases: { name: string; primitive: Primitive; check: (out: Primitive) => void }[] = [
  {
    name: 'point',
    primitive: { type: 'point', p: [1, 0, 0] },
    check: (out) => {
      if (out.type !== 'point') throw new Error(out.type)
      expectVec(out.p, [10, 1, 0])
    },
  },
  {
    name: 'line',
    primitive: { type: 'line', p0: [0, 0, 0], p1: [1, 0, 0], dir: [1, 0, 0], bounded: true },
    check: (out) => {
      if (out.type !== 'line') throw new Error(out.type)
      expectVec(out.p0, [10, 0, 0])
      expectVec(out.p1, [10, 1, 0])
      expectVec(out.dir, [0, 1, 0])
      expect(out.bounded).toBe(true)
    },
  },
  {
    name: 'circle',
    primitive: { type: 'circle', center: [1, 0, 0], axis: [0, 0, 1], radius: 4, sweep: Math.PI },
    check: (out) => {
      if (out.type !== 'circle') throw new Error(out.type)
      expectVec(out.center, [10, 1, 0])
      expectVec(out.axis, [0, 0, 1])
      expect(out.radius).toBe(4)
      expect(out.sweep).toBe(Math.PI)
    },
  },
  {
    name: 'ellipse',
    primitive: { type: 'ellipse', center: [1, 0, 0], axis: [0, 0, 1], a: 4, b: 2 },
    check: (out) => {
      if (out.type !== 'ellipse') throw new Error(out.type)
      expectVec(out.center, [10, 1, 0])
      expectVec(out.axis, [0, 0, 1])
      expect(out.a).toBe(4)
      expect(out.b).toBe(2)
    },
  },
  {
    name: 'plane',
    primitive: { type: 'plane', point: [1, 0, 0], normal: [1, 0, 0], bounded: true },
    check: (out) => {
      if (out.type !== 'plane') throw new Error(out.type)
      expectVec(out.point, [10, 1, 0])
      expectVec(out.normal, [0, 1, 0])
      expect(out.bounded).toBe(true)
    },
  },
  {
    name: 'cylinder',
    primitive: { type: 'cylinder', axisPoint: [1, 0, 0], axis: [1, 0, 0], radius: 3, length: 12 },
    check: (out) => {
      if (out.type !== 'cylinder') throw new Error(out.type)
      expectVec(out.axisPoint, [10, 1, 0])
      expectVec(out.axis, [0, 1, 0])
      expect(out.radius).toBe(3)
      expect(out.length).toBe(12)
    },
  },
  {
    name: 'sphere',
    primitive: { type: 'sphere', center: [1, 0, 0], radius: 5 },
    check: (out) => {
      if (out.type !== 'sphere') throw new Error(out.type)
      expectVec(out.center, [10, 1, 0])
      expect(out.radius).toBe(5)
    },
  },
  {
    name: 'cone',
    primitive: { type: 'cone', axisPoint: [1, 0, 0], axis: [1, 0, 0], semiAngle: 0.5 },
    check: (out) => {
      if (out.type !== 'cone') throw new Error(out.type)
      expectVec(out.axisPoint, [10, 1, 0])
      expectVec(out.axis, [0, 1, 0])
      expect(out.semiAngle).toBe(0.5)
    },
  },
  {
    name: 'torus',
    primitive: { type: 'torus', center: [1, 0, 0], axis: [1, 0, 0], majorRadius: 8, minorRadius: 2 },
    check: (out) => {
      if (out.type !== 'torus') throw new Error(out.type)
      expectVec(out.center, [10, 1, 0])
      expectVec(out.axis, [0, 1, 0])
      expect(out.majorRadius).toBe(8)
      expect(out.minorRadius).toBe(2)
    },
  },
  {
    name: 'opaque',
    primitive: { type: 'opaque', what: 'spline edge', ref: 'e' },
    check: (out) => {
      expect(out).toEqual({ type: 'opaque', what: 'spline edge', ref: 'e' })
    },
  },
  {
    name: 'solid',
    primitive: { type: 'solid', partId: 'p1' },
    check: (out) => {
      expect(out).toEqual({ type: 'solid', partId: 'p1' })
    },
  },
]

describe('transformPrimitive', () => {
  for (const { name, primitive, check } of cases) {
    it(`carries a ${name} into the pose`, () => {
      check(transformPrimitive(primitive, pose))
    })
  }

  it('leaves an absent radius or sweep absent instead of inventing one', () => {
    const bare: Primitive = { type: 'circle', center: [1, 0, 0], axis: [0, 0, 1] }
    expect(transformPrimitive(bare, pose)).toEqual({
      type: 'circle', center: [10, 1, 0], axis: [0, 0, 1],
    })
  })
})
