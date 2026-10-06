// Unit coverage for the shared vec3 primitives used by the viewport math and
// the feature solvers. These helpers are byte-for-byte identical across
// plane/upTo/projectionLowering/gizmoMath, so they get one direct test here
// instead of per-caller.

import { describe, it, expect } from 'vitest'
import { add, scale, sub, dot, cross, type Vec3 } from '@/utils/vec3'

describe('vec3.sub', () => {
  it('subtracts componentwise', () => {
    expect(sub([1, 2, 3], [4, 6, 8])).toEqual([-3, -4, -5])
  })

  it('returns the zero vector for identical inputs', () => {
    expect(sub([5, -7, 2], [5, -7, 2])).toEqual([0, 0, 0])
  })

  it('negates when operands swap', () => {
    const a: Vec3 = [3, -1, 4]
    const b: Vec3 = [-2, 5, 0]
    const ba = sub(b, a)
    expect(sub(a, b)).toEqual([-ba[0], -ba[1], -ba[2]])
  })
})

describe('vec3.add', () => {
  it('adds componentwise', () => {
    expect(add([1, 2, 3], [4, 6, 8])).toEqual([5, 8, 11])
  })

  it('inverts sub', () => {
    const a: Vec3 = [3, -1, 4]
    const b: Vec3 = [-2, 5, 0]
    expect(add(a, sub(b, a))).toEqual(b)
  })
})

describe('vec3.scale', () => {
  it('multiplies every component', () => {
    expect(scale([1, -2, 3], 2)).toEqual([2, -4, 6])
  })

  it('returns the zero vector at factor zero', () => {
    expect(scale([1, 2, 3], 0)).toEqual([0, 0, 0])
  })
})

describe('vec3.dot', () => {
  it('sums the products of components', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32)
  })

  it('is zero for perpendicular axes', () => {
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0)
  })

  it('returns the squared length when dotted with itself', () => {
    expect(dot([3, 4, 0], [3, 4, 0])).toBe(25)
  })

  it('is commutative', () => {
    expect(dot([2, -3, 5], [-1, 4, 6])).toBe(dot([-1, 4, 6], [2, -3, 5]))
  })
})

describe('vec3.cross', () => {
  it('matches the right-hand rule for the basis vectors', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
    expect(cross([0, 1, 0], [0, 0, 1])).toEqual([1, 0, 0])
    expect(cross([0, 0, 1], [1, 0, 0])).toEqual([0, 1, 0])
  })

  it('anticommutes when operands swap', () => {
    const a: Vec3 = [1, 2, 3]
    const b: Vec3 = [4, 5, 6]
    const ab = cross(a, b)
    const ba = cross(b, a)
    expect(ab).toEqual([-ba[0], -ba[1], -ba[2]])
  })

  it('returns the zero vector for parallel inputs', () => {
    expect(cross([2, 4, 6], [1, 2, 3])).toEqual([0, 0, 0])
  })

  it('is orthogonal to both operands', () => {
    const a: Vec3 = [3, -3, 1]
    const b: Vec3 = [4, 9, 2]
    const n = cross(a, b)
    expect(dot(n, a)).toBe(0)
    expect(dot(n, b)).toBe(0)
  })
})
