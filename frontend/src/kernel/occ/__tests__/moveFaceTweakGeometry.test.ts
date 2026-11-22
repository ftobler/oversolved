// OCC-free tests for the direct move-face's arithmetic: the three-plane vertex
// solve and the intersection-branch choice.
import { describe, it, expect } from 'vitest'
import { chooseBranch, intersectThreePlanes, nearestIndex } from '../moveFaceTweakGeometry'

describe('move-face tweak geometry', () => {
  it('solves the three axis planes at their corner', () => {
    const solved = intersectThreePlanes(
      { point: [2, 0, 0], normal: [1, 0, 0] },
      { point: [0, 3, 0], normal: [0, 1, 0] },
      { point: [0, 0, 4], normal: [0, 0, 1] },
    )
    expect(solved).toEqual([2, 3, 4])
  })

  it('returns null for coplanar normals and for three planes through one line', () => {
    expect(intersectThreePlanes(
      { point: [0, 0, 0], normal: [1, 0, 0] },
      { point: [1, 0, 0], normal: [1, 0, 0] },
      { point: [0, 0, 0], normal: [0, 0, 1] },
    )).toBeNull()
    expect(intersectThreePlanes(
      { point: [0, 0, 0], normal: [1, 0, 0] },
      { point: [0, 0, 0], normal: [0, 1, 0] },
      { point: [0, 0, 0], normal: [1, 1, 0] },
    )).toBeNull()
  })

  it('nearestIndex picks the closest candidate', () => {
    expect(nearestIndex([[0, 0, 0], [10, 0, 0], [5, 5, 0]], [4, 1, 0])).toBe(0)
    expect(nearestIndex([], [0, 0, 0])).toBe(-1)
  })

  it('chooseBranch prefers the nearest midpoint, tangent breaking a near-tie', () => {
    expect(chooseBranch(
      [[0, 0, 0], [10, 0, 0]],
      [null, null],
      [1, 0, 0],
      null,
      1e-3,
    )).toBe(0)
    // Two branches at the same distance but opposite tangents: the aligned one
    // continues the old edge.
    const index = chooseBranch(
      [[0, 0, 0], [0, 0, 0]],
      [[1, 0, 0], [-1, 0, 0]],
      [0, 0, 0],
      [1, 0, 0],
      1e-3,
    )
    expect(index).toBe(0)
  })
})
