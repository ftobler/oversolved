import { describe, it, expect } from 'vitest'
import { segmentsAreParallel, PARALLEL_CROSS_EPS } from '@/utils/geometry/segmentGeometry'

describe('segmentsAreParallel', () => {
  it('true for collinear / same-direction segments', () => {
    expect(segmentsAreParallel([0, 0], [10, 0], [0, 5], [10, 5])).toBe(true)
  })

  it('true for anti-parallel (reversed) segments', () => {
    expect(segmentsAreParallel([0, 0], [10, 0], [10, 5], [0, 5])).toBe(true)
  })

  it('false for perpendicular segments', () => {
    expect(segmentsAreParallel([0, 0], [10, 0], [0, 0], [0, 10])).toBe(false)
  })

  it('false when either segment is zero-length', () => {
    expect(segmentsAreParallel([0, 0], [0, 0], [0, 0], [10, 0])).toBe(false)
    expect(segmentsAreParallel([0, 0], [10, 0], [5, 5], [5, 5])).toBe(false)
  })

  it('treats a sub-epsilon skew as parallel and a larger one as not', () => {
    const within = PARALLEL_CROSS_EPS / 2
    expect(segmentsAreParallel([0, 0], [1, 0], [0, 0], [1, within])).toBe(true)
    expect(segmentsAreParallel([0, 0], [1, 0], [0, 0], [1, 1e-3])).toBe(false)
  })
})
