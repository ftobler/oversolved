import { describe, it, expect } from 'vitest'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { assemblyVerdict, mateFailure, partFailure } from '@/utils/core/assemblyStatus'

function stub(overrides: Partial<AssemblySolveStatus> = {}): AssemblySolveStatus {
  return {
    verdict: 'fully_constrained',
    residualNorm: 0,
    rank: 0,
    dof: 0,
    iters: 0,
    mates: {},
    parts: {},
    ...overrides,
  }
}

describe('assemblyVerdict', () => {
  it('is no mark for a trivial, fully constrained or absent solve', () => {
    for (const status of [null, stub({ verdict: 'none' }), stub({ verdict: 'fully_constrained' })]) {
      const mark = assemblyVerdict(status)
      expect(mark.failed).toBe(false)
      expect(mark.level).toBeNull()
    }
  })

  it('is a hard error for overconstrained and names the unsatisfiable mates', () => {
    const mark = assemblyVerdict(stub({
      verdict: 'overconstrained',
      residualNorm: 0.5,
      mates: { m1: { stale: false }, m2: { stale: false } },
    }))
    expect(mark.failed).toBe(true)
    expect(mark.level).toBe('error')
    expect(mark.message).toContain('m1')
    expect(mark.message).toContain('m2')
  })

  it('carries the transport error for failed and unavailable', () => {
    expect(assemblyVerdict(stub({ verdict: 'failed', error: 'bad magic' }))).toMatchObject({
      failed: true, level: 'error', message: 'bad magic',
    })
    expect(assemblyVerdict(stub({ verdict: 'unavailable', error: 'Mate solver not available.' }))).toMatchObject({
      failed: true, level: 'error', message: 'Mate solver not available.',
    })
  })

  it('is informational, not a failure, for underconstrained', () => {
    const mark = assemblyVerdict(stub({ verdict: 'underconstrained', dof: 3 }))
    expect(mark.failed).toBe(false)
    expect(mark.level).toBe('warning')
    expect(mark.message).toContain('3')
  })
})

describe('mateFailure', () => {
  it('marks an error even when stale is unset (the solver-trap shape)', () => {
    const status = stub({ mates: { m1: { error: 'bad mate output magic' } } })
    expect(mateFailure('m1', status)).toMatchObject({
      failed: true, level: 'error', message: 'bad mate output magic',
    })
  })

  it('renders the unsupported-kind cause rather than the re-pick text', () => {
    const status = stub({ mates: { m1: { stale: true, error: "unsupported mate kind 'worm_gear'" } } })
    expect(mateFailure('m1', status)).toMatchObject({
      failed: true, level: 'error', message: "unsupported mate kind 'worm_gear'",
    })
  })

  it('tells a bare unresolved reference to re-pick', () => {
    const status = stub({ mates: { m1: { stale: true, staleRefs: ['ref_b'] } } })
    expect(mateFailure('m1', status).failed).toBe(true)
    expect(mateFailure('m1', status).message).toContain('re-pick')
  })

  it('names a failed referenced part instead of the generic stale-ref text', () => {
    const status = stub({
      mates: { m1: { stale: true, staleRefs: ['ref_a'] } },
      parts: { hBad: { failed: true, error: 'part doc not found: hBad' } },
    })
    expect(mateFailure('m1', status, ['hBad', 'hGood'])).toMatchObject({
      failed: true, level: 'error', message: 'The referenced part failed to load.',
    })
  })

  it('is no mark for a healthy or absent mate', () => {
    expect(mateFailure('m1', stub({ mates: { m1: { stale: false } } })).failed).toBe(false)
    expect(mateFailure('m1', stub()).failed).toBe(false)
    expect(mateFailure('m1', null).failed).toBe(false)
  })
})

describe('partFailure', () => {
  it('marks a failed part and leaves healthy or absent ones alone', () => {
    const status = stub({ parts: { hBad: { failed: true, error: 'part doc not found: hBad' } } })
    expect(partFailure('hBad', status)).toMatchObject({
      failed: true, level: 'error', message: 'part doc not found: hBad',
    })
    expect(partFailure('hGood', status).failed).toBe(false)
    expect(partFailure('hBad', null).failed).toBe(false)
  })
})
