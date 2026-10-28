import { describe, it, expect } from 'vitest'
import { loadPartDoc, MAX_INITIAL_PARAMS } from '@/persistence/docSchema'

/** A one-sketch part carrying the given entity records and initial blocks. */
function part(
  entities: Array<Record<string, unknown>>,
  initial: Record<string, number[]>,
): Record<string, unknown> {
  return {
    version: 3,
    kind: 'part',
    features: [{ id: 'sk1', kind: 'sketch', entities, initial, constraints: [] }],
  }
}

function points(n: number): number[] {
  return Array.from({ length: n }, (_, i) => [i, i % 3]).flat()
}

describe('fit_spline document loading', () => {
  it('loads a fit_spline with both handles and its 2N + 4 block', () => {
    const result = loadPartDoc(part(
      [{ id: 'sp', kind: 'fit_spline', handles: 'both' }],
      { sp: [...points(4), 9, 9, 10, 10] },
    ))
    expect(result.ok).toBe(true)
  })

  it('loads 64 points with both handles at the 132-param cap', () => {
    expect(MAX_INITIAL_PARAMS).toBe(132)
    const result = loadPartDoc(part(
      [{ id: 'sp', kind: 'fit_spline', handles: 'both' }],
      { sp: [...points(64), 9, 9, 10, 10] },
    ))
    expect(result.ok).toBe(true)
  })

  it('rejects handles on a non-fit_spline entity', () => {
    const result = loadPartDoc(part(
      [{ id: 'l1', kind: 'line', handles: 'both' }],
      { l1: [0, 0, 1, 1] },
    ))
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown handles value', () => {
    const result = loadPartDoc(part(
      [{ id: 'sp', kind: 'fit_spline', handles: 'middle' }],
      { sp: points(3) },
    ))
    expect(result.ok).toBe(false)
  })

  it('rejects a missing or odd initial block', () => {
    expect(loadPartDoc(part([{ id: 'sp', kind: 'fit_spline' }], {})).ok).toBe(false)
    expect(loadPartDoc(part([{ id: 'sp', kind: 'fit_spline' }], { sp: [0, 0, 1, 1, 2] })).ok).toBe(false)
  })

  it('rejects 65 fit points', () => {
    expect(loadPartDoc(part(
      [{ id: 'sp', kind: 'fit_spline' }],
      { sp: points(65) },
    )).ok).toBe(false)
  })
})
