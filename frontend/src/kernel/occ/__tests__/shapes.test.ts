import { describe, it, expect } from 'vitest'
import { triangleArea, faceSortKey, compareFaceSortKeys, type FaceSortItem } from '../shapes'
import type { Vec3 } from '../primitives'

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

  it('throws on a NaN component instead of returning a permutation-dependent order', () => {
    const k = faceSortKey(flat([0, 0, 1], [0, 0, 0]))
    const bad = [...k]
    bad[1] = NaN  // a normal component
    expect(() => compareFaceSortKeys(k, bad)).toThrow(/face sort key component 1 is NaN/)
    expect(() => compareFaceSortKeys(bad, k)).toThrow(/face sort key component 1 is NaN/)
  })

  // A shorter key must not read as EQUAL. Indexing past the end yields
  // `undefined`, which slips through the NaN guard above (Number.isNaN(undefined)
  // is false) and then compares false in both directions -- so the comparator
  // returned 0 and the sort went permutation-dependent, the exact outcome that
  // guard exists to prevent. faceSortKey always emits 7 components, so this is
  // unreachable through it; the comparator is exported and must be total anyway.
  // compareEdgeSortKeys already works this way, and has to: edge keys run
  // 8/11/12 components by curve kind.
  it('orders a shorter key before its own prefix rather than calling them equal', () => {
    const k = faceSortKey(flat([0, 0, 1], [1, 2, 3]))
    const short = k.slice(0, 4)
    expect(compareFaceSortKeys(short, k)).toBeLessThan(0)
    expect(compareFaceSortKeys(k, short)).toBeGreaterThan(0)
    expect(compareFaceSortKeys(k, [...k])).toBe(0)
  })
})
