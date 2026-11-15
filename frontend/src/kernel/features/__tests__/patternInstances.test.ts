// The shared instance model: counts, centered ranges, grid cells, skip
// filtering, the stale-skip warning and the circular coincidence rule. Pure
// numbers, no OCC and no repository.
import { describe, it, expect } from 'vitest'
import {
  circularCoincidentRefusal,
  filterSkippedInstances,
  generatedCount,
  instanceIndices,
  instanceSummary,
  instanceTotalProblem,
  patternCountProblem,
  rectangularIndices,
  staleSkipWarnings,
  toInstances,
} from '../patternInstances'
import { MAX_ARRAY_COUNT } from '@/utils/core/arrayLimits'

describe('instanceIndices', () => {
  it('generates the forward range for an uncentered count', () => {
    expect(instanceIndices(1, false)).toEqual([])
    expect(instanceIndices(2, false)).toEqual([1])
    expect(instanceIndices(3, false)).toEqual([1, 2])
  })

  it('adds the reverse side for a centered count', () => {
    expect(instanceIndices(1, true)).toEqual([])
    expect(instanceIndices(2, true)).toEqual([1, -1])
    expect(instanceIndices(3, true)).toEqual([1, -1, 2, -2])
  })

  it('counts the original in the generated total', () => {
    expect(generatedCount(2, false)).toBe(2)
    expect(generatedCount(2, true)).toBe(3)
    expect(generatedCount(3, true)).toBe(5)
  })
})

describe('rectangularIndices', () => {
  it('is the product without the seed cell', () => {
    expect(rectangularIndices(2, 2, false, false)).toEqual([[1, 0], [0, 1], [1, 1]])
    expect(rectangularIndices(1, 1, false, false)).toEqual([])
  })

  it('centers each axis on its own flag', () => {
    expect(rectangularIndices(2, 1, true, false)).toEqual([[1, 0], [-1, 0]])
    expect(rectangularIndices(2, 2, true, true)).toEqual([
      [1, 0], [-1, 0],
      [0, 1], [1, 1], [-1, 1],
      [0, -1], [1, -1], [-1, -1],
    ])
  })
})

describe('skip filtering', () => {
  const generated = toInstances(instanceIndices(4, false))

  it('drops the named instance and keeps the order', () => {
    expect(filterSkippedInstances(generated, [2]).kept.map((instance) => instance.key)).toEqual(['1', '3'])
    expect(filterSkippedInstances(generated, [2]).stale).toEqual([])
  })

  it('reports an entry the count does not generate instead of failing', () => {
    const filtered = filterSkippedInstances(generated, [2, 9])
    expect(filtered.kept.map((instance) => instance.key)).toEqual(['1', '3'])
    expect(filtered.stale).toEqual([9])
    expect(staleSkipWarnings(filtered.stale, 'count 4')).toEqual([
      'skip lists instance 9, which count 4 does not generate',
    ])
  })

  it('reports a negative index when centered is off', () => {
    expect(filterSkippedInstances(generated, [-1]).stale).toEqual([-1])
  })

  it('keys a grid cell as column:row and matches a bare entry as column 0', () => {
    const cells = toInstances(rectangularIndices(2, 2, false, false))
    expect(cells.map((instance) => instance.key)).toEqual(['1:0', '0:1', '1:1'])
    expect(filterSkippedInstances(cells, [1]).kept.map((instance) => instance.key)).toEqual(['0:1', '1:1'])
    expect(filterSkippedInstances(cells, [[1, 1]]).kept.map((instance) => instance.key)).toEqual(['1:0', '0:1'])
  })
})

describe('count and total caps', () => {
  it('refuses a count below 1 or a non-integer', () => {
    expect(patternCountProblem(1)).toBeNull()
    for (const count of [0, -2, 2.5, Number.NaN]) {
      expect(patternCountProblem(count), String(count)).toContain('whole number of at least 1')
    }
  })

  it('counts the centered total against the cap', () => {
    expect(instanceTotalProblem(generatedCount(500, true))).toBeNull()
    expect(instanceTotalProblem(generatedCount(501, true))).toContain(String(MAX_ARRAY_COUNT))
  })
})

describe('circular coincidence', () => {
  it('refuses a step that lands a copy on the seed', () => {
    // count 5 with an explicit 90 degree step puts instance 4 at 360.
    expect(circularCoincidentRefusal(instanceIndices(5, false), 90)).toBe(
      'pattern: instance 4 lands on instance 0 (step 90 deg); lower the count or change the angle',
    )
  })

  it('accepts the evenly spaced centered step', () => {
    // 360 / (2 * 5 - 1) = 40 degrees: instances 1..4 either side never meet.
    expect(circularCoincidentRefusal(instanceIndices(5, true), 40)).toBeNull()
  })

  it('refuses the centered pair that lands on the same side', () => {
    // +2 and -2 are both 180 degrees at a 90 degree step.
    expect(circularCoincidentRefusal(instanceIndices(3, true), 90)).toContain('lands on instance')
  })
})

describe('instanceSummary', () => {
  it('states the total, the new copies and the skipped count', () => {
    expect(instanceSummary(toInstances(instanceIndices(4, false)), 0)).toBe('4 instances, 3 new')
    expect(instanceSummary(toInstances(instanceIndices(4, false)), 1)).toBe('4 instances, 2 new, 1 skipped')
    expect(instanceSummary(toInstances(instanceIndices(2, true)), 0)).toBe('3 instances, 2 new')
    expect(instanceSummary([], 0)).toBe('1 instance, 0 new')
  })
})
