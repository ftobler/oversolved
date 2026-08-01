import { describe, it, expect } from 'vitest'
import { triangleArea, faceSortKey, compareFaceSortKeys, type FaceSortItem } from './shapes'
import type { Vec3 } from './primitives'

describe('triangleArea', () => {
  it('computes a unit right triangle', () => {
    expect(triangleArea([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(0.5, 12)
  })
  it('is independent of winding', () => {
    const a = triangleArea([0, 0, 0], [2, 0, 0], [0, 3, 0])
    const b = triangleArea([0, 0, 0], [0, 3, 0], [2, 0, 0])
    expect(a).toBeCloseTo(b, 12)
    expect(a).toBeCloseTo(3, 12)
  })
  it('handles a degenerate (collinear) triangle as zero area', () => {
    expect(triangleArea([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeCloseTo(0, 12)
  })
})

describe('faceSortKey / compareFaceSortKeys', () => {
  const flat = (normal: Vec3, centroid: Vec3): FaceSortItem => ({
    normal,
    centroid,
    surfaceType: 'flatface',
  })
  const curved = (normal: Vec3, centroid: Vec3): FaceSortItem => ({
    normal,
    centroid,
    surfaceType: 'cylinderface',
  })

  it('orders flat faces before curved regardless of geometry', () => {
    const a = faceSortKey(curved([0, 0, -1], [0, 0, 0]))
    const b = faceSortKey(flat([1, 0, 0], [100, 100, 100]))
    expect(compareFaceSortKeys(b, a)).toBe(-1)  // flat sorts first
  })

  it('within a group, orders by normal then centroid', () => {
    const items: FaceSortItem[] = [
      flat([1, 0, 0], [5, 0, 0]),
      flat([-1, 0, 0], [0, 0, 0]),
      flat([0, 1, 0], [5, 5, 0]),
    ]
    const sorted = [...items].sort((x, y) => compareFaceSortKeys(faceSortKey(x), faceSortKey(y)))
    // normals sort -1 < 0 < 1 on the first axis
    expect(sorted.map((i) => i.normal[0])).toEqual([-1, 0, 1])
  })

  it('quantises to 6 decimals so sub-micron jitter does not reorder', () => {
    const a = faceSortKey(flat([1, 0, 0], [1.0000001, 0, 0]))
    const b = faceSortKey(flat([1, 0, 0], [1.0000002, 0, 0]))
    expect(compareFaceSortKeys(a, b)).toBe(0)
  })
})
