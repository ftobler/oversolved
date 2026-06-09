import { describe, it, expect } from 'vitest'
import { computeNaturalDimensionValue } from '@/utils/geometry/dimensionNaturalValue'
import type { Sketch } from '@/types/cad'

const FID = 'S1'

function makeSketch(): Sketch {
  return {
    L1: { start: [0, 0], end: [10, 0] },        // horizontal length 10
    L2: { start: [0, 0], end: [0, 5] },         // vertical length 5
    L3: { start: [0, 0], end: [3, 4] },         // length 5, 36.87 deg from L1
    C1: { center: [0, 0], radius: 7 },          // circle r=7, d=14
    A1: { start: [5, 0], end: [0, 5], center: [0, 0], radius: 5 },  // arc r=5
    P1: { x: 2, y: 0 } as unknown as Sketch[string],
    P2: { x: 5, y: 4 } as unknown as Sketch[string],
  } as Sketch
}

describe('computeNaturalDimensionValue', () => {
  it('length: distance between line endpoints', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('length', ['entity:S1:L1'], sk, FID)).toBe(10)
    expect(computeNaturalDimensionValue('length', ['entity:S1:L3'], sk, FID)).toBe(5)
  })

  it('radius: arc radius', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('radius', ['entity:S1:A1'], sk, FID)).toBe(5)
  })

  it('diameter: 2 * circle radius', () => {
    const sk = makeSketch()
    expect(computeNaturalDimensionValue('diameter', ['entity:S1:C1'], sk, FID)).toBe(14)
  })

  it('point_distance: distance between two points', () => {
    const sk = makeSketch()
    // P1 (2,0), P2 (5,4) -> hypot(3,4) = 5
    const v = computeNaturalDimensionValue(
      'point_distance',
      ['vertex:S1:P1', 'vertex:S1:P2'],
      sk, FID,
    )
    expect(v).toBe(5)
  })

  it('line_distance: perpendicular point-to-line distance', () => {
    const sk = makeSketch()
    // P2 (5,4) onto L1 (horizontal y=0) -> distance 4
    const v = computeNaturalDimensionValue(
      'line_distance',
      ['entity:S1:L1', 'vertex:S1:P2'],
      sk, FID,
    )
    expect(v).toBe(4)
  })

  it('angle: signed angle between two line directions, in degrees', () => {
    const sk = makeSketch()
    // L1 horizontal, L2 vertical -> 90 deg
    const v = computeNaturalDimensionValue(
      'angle',
      ['entity:S1:L1', 'entity:S1:L2'],
      sk, FID,
    )
    expect(v).toBeCloseTo(90, 6)
  })

  it('returns null for unresolvable geometry', () => {
    const sk = makeSketch()
    // Missing entity should return null (computeConstraintRender -> 'unknown')
    expect(computeNaturalDimensionValue(
      'length', ['entity:S1:NX'], sk, FID,
    )).toBeNull()
  })
})
