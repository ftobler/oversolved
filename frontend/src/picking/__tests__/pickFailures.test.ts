import { describe, it, expect } from 'vitest'
import { failedPickQueries } from '@/picking/pickFailures'

describe('failedPickQueries', () => {
  it('unions failed_edges and failed_faces across every feature', () => {
    const failed = failedPickQueries({
      fi1: { status: 'partial', failed_edges: ['?e1;e', '?e2;e'] },
      sh1: { status: 'partial', failed_faces: ['?f1;f'] },
    })
    expect(failed).toEqual(new Set(['?e1;e', '?e2;e', '?f1;f']))
  })

  it('does not read unresolved picks: they are not on screen to paint', () => {
    const failed = failedPickQueries({
      fi1: { status: 'partial', unresolved_edges: ['?gone;e'], failed_edges: ['?e1;e'] },
    })
    expect(failed).toEqual(new Set(['?e1;e']))
  })

  it('tolerates a result that is not an object', () => {
    expect(failedPickQueries({ ex1: null, ex2: 'ok', ex3: undefined }).size).toBe(0)
    expect(failedPickQueries(undefined).size).toBe(0)
  })
})
