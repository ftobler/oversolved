// A reached joint bound is surface data, not a problem: the reply must name it
// while `ok` stays true and the mate is absent from the problems list.
import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import type { AssemblyBuildResponse, AssemblySolveStatus } from '@/kernel/solveAssembly'
import { mateFrames, mateProblems, summarizeAssembly } from '@/drive/assemblyOutcome'

const doc: AssemblyDoc = {
  kind: 'assembly',
  features: [{
    id: 'm1',
    kind: 'mate',
    mate: {
      kind: 'sliding',
      ref_a: { part: 'h1', anchor: 'a' },
      ref_b: { part: 'h2', anchor: 'b' },
      limit_max: 10,
    },
  }],
}

function status(limit?: 'min' | 'max' | 'both'): AssemblySolveStatus {
  return {
    verdict: 'fully_constrained',
    residualNorm: 0,
    rank: 6,
    dof: 0,
    iters: 4,
    mates: { m1: { stale: false, residual: 0, ...(limit !== undefined && { limit }) } },
    parts: {},
  }
}

const response: AssemblyBuildResponse = {
  transforms: {},
  bodies: {},
  anchors: {
    h1: { a: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], x_axis: [1, 0, 0] } },
    h2: { b: { kind: 'plane', point: [0, 0, 10], axis: [0, 0, 1], x_axis: [1, 0, 0] } },
  },
  anchorDescriptors: {},
  status: status('max'),
}

describe('assembly reply: joint limits', () => {
  it('names a reached bound in the summary without listing it as a problem', () => {
    const mateStatus = status('max')
    expect(mateProblems(doc, mateStatus)).toEqual([])
    expect(summarizeAssembly(doc, mateStatus, [], [])).toContain('limits: m1 (max)')
  })

  it('omits the limits segment when every joint is inside its range', () => {
    expect(summarizeAssembly(doc, status(), [], [])).not.toContain('limits')
  })

  it('carries the bound on the mate frame', () => {
    expect(mateFrames(doc, response).m1.limit).toBe('max')
  })
})
