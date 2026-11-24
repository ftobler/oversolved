// The inherited-precision rules the kernel half of the solver/kernel contract
// reads: the floor at OCC's pair, the ceiling on a merge, the warning when a
// merge has to run clamped, and the repo bridge that carries a sketch solve's
// reported misses to the feature that builds from it.
//
// No OCC here: these are arithmetic and registration rules. The real merge
// behaviour (the setters, the two-box crease, the deliberate tilt) lives in
// `occ/__tests__/mergeToleranceReal.test.ts` and the feature-level suite.

import { describe, it, expect } from 'vitest'
import {
  MERGE_CEILING,
  contractPrecision,
  maxPrecision,
  mergeTolerance,
  precisionCeilingWarning,
  precisionKey,
  precisionOfSolve,
  sketchPrecision,
  type KernelPrecision,
} from '../precision'
import { OCC_ANGULAR, OCC_CONFUSION } from '../solverConstants'
import { initGlobalRepo } from '../query'
import { clearFeatureGeometryRegistrations, postRegister } from '../features/postRegister'

const p = (angular: number, linear: number, sketch?: string, sketchName?: string): KernelPrecision => (
  { angular, linear, ...(sketch ? { sketch } : {}), ...(sketchName ? { sketch_name: sketchName } : {}) }
)

describe('contractPrecision', () => {
  it('floors a reported miss at the contract pair', () => {
    expect(contractPrecision(1e-15, 1e-12)).toEqual(p(OCC_ANGULAR, OCC_CONFUSION))
  })

  it('keeps an above-contract miss and the sketch that reported it', () => {
    expect(contractPrecision(3e-11, 4e-7, 'sk1')).toEqual(p(3e-11, 4e-7, 'sk1'))
  })

  // The solver reports NaN when no row of a class was measured, and INFINITY on
  // a row-classification failure. Neither is a measurement: widening on one
  // would merge creases no row vouched for.
  it('reads a non-finite report as the contract, never as a wider merge', () => {
    expect(contractPrecision(NaN, NaN)).toEqual(p(OCC_ANGULAR, OCC_CONFUSION))
    expect(contractPrecision(Infinity, -Infinity)).toEqual(p(OCC_ANGULAR, OCC_CONFUSION))
    expect(contractPrecision(undefined, 'nonsense')).toEqual(p(OCC_ANGULAR, OCC_CONFUSION))
  })
})

describe('maxPrecision', () => {
  it('takes the componentwise max and keeps the dominating sketch', () => {
    const coarse = p(3e-11, OCC_CONFUSION, 'sk1')
    const fine = p(OCC_ANGULAR, 2e-7, 'sk2')
    expect(maxPrecision(coarse, fine)).toEqual(p(3e-11, 2e-7, 'sk1'))
  })

  it('treats an absent operand as nothing', () => {
    expect(maxPrecision(null, p(3e-11, 4e-7, 'sk1'))).toEqual(p(3e-11, 4e-7, 'sk1'))
    expect(maxPrecision(p(3e-11, 4e-7), undefined)).toEqual(p(3e-11, 4e-7))
    expect(maxPrecision(null, null)).toBeNull()
  })
})

describe('mergeTolerance', () => {
  it('with no inherited precision reads the contract pair', () => {
    expect(mergeTolerance(null)).toEqual({
      angularTol: OCC_ANGULAR,
      linearTol: OCC_CONFUSION,
      ceilingMiss: null,
    })
    expect(mergeTolerance(undefined)).toEqual(mergeTolerance(null))
  })

  it('widens by a reported miss inside the ceiling', () => {
    expect(mergeTolerance(p(1e-10, 5e-7))).toEqual({
      angularTol: 1e-10,
      linearTol: 5e-7,
      ceilingMiss: null,
    })
  })

  it('clamps past the ceiling and says which axes were clamped', () => {
    const wide = mergeTolerance(p(5e-9, 5e-6))
    expect(wide.angularTol).toBe(MERGE_CEILING.angular)
    expect(wide.linearTol).toBe(MERGE_CEILING.linear)
    expect(wide.ceilingMiss).toEqual({ angular: true, linear: true })
  })

  it('clamps each axis on its own', () => {
    expect(mergeTolerance(p(5e-9, OCC_CONFUSION)).ceilingMiss).toEqual({ angular: true, linear: false })
    expect(mergeTolerance(p(OCC_ANGULAR, 5e-6)).ceilingMiss).toEqual({ angular: false, linear: true })
  })

  it('a miss exactly at the ceiling is not clamped', () => {
    const at = mergeTolerance(p(MERGE_CEILING.angular, MERGE_CEILING.linear))
    expect(at.ceilingMiss).toBeNull()
    expect(at.angularTol).toBe(MERGE_CEILING.angular)
  })
})

describe('precisionCeilingWarning', () => {
  it('names the sketch, its realised miss and the ceiling', () => {
    // A record with no display name gets the noun, never the raw sketch id.
    const warning = precisionCeilingWarning({ ...p(3e-9, OCC_CONFUSION, 'sk1') })
    expect(warning).toBe(
      "the sketch solved to 3e-9 rad, above the kernel's 1e-9 merge ceiling; " +
      'near-coplanar faces may stay split',
    )
    const named = precisionCeilingWarning(p(3e-9, OCC_CONFUSION, 'sk1', 'sketch 1'))
    expect(named).toBe(
      "sketch 1 solved to 3e-9 rad, above the kernel's 1e-9 merge ceiling; " +
      'near-coplanar faces may stay split',
    )
  })

  it('has a linear clause and a nameless form', () => {
    expect(precisionCeilingWarning(p(OCC_ANGULAR, 2e-6))).toContain(
      "the merged geometry carries 2e-6, above the kernel's 1e-6 merge ceiling",
    )
  })

  it('is silent for a within-contract or within-ceiling record', () => {
    expect(precisionCeilingWarning(p(OCC_ANGULAR, OCC_CONFUSION))).toBeNull()
    expect(precisionCeilingWarning(p(1e-10, 5e-7, 'sk1'))).toBeNull()
  })
})

describe('the sketch precision bridge', () => {
  it('publishes the solve report beside the topology and reads it back', () => {
    const repo = initGlobalRepo()
    postRegister(repo, 'sk1', { id: 'sk1', kind: 'sketch' }, {
      status: 'ok', angular_miss: 3e-11, linear_miss: 4e-7,
    })
    expect(repo.elements.get(precisionKey('sk1'))).toEqual(p(3e-11, 4e-7, 'sk1', 'the sketch'))
    expect(sketchPrecision(repo, 'sk1')).toEqual(p(3e-11, 4e-7, 'sk1', 'the sketch'))
  })

  it('floors an unmeasured (NaN) solve at the contract', () => {
    const repo = initGlobalRepo()
    postRegister(repo, 'sk1', { id: 'sk1', kind: 'sketch' }, {
      status: 'underconstrained', angular_miss: NaN, linear_miss: NaN,
    })
    expect(sketchPrecision(repo, 'sk1')).toEqual(p(OCC_ANGULAR, OCC_CONFUSION, 'sk1', 'the sketch'))
  })

  it('publishes nothing for a feature whose result carries no miss', () => {
    const repo = initGlobalRepo()
    postRegister(repo, 'ex1', { id: 'ex1', kind: 'extrude' }, { status: 'ok', body_id: 'body_ex1' })
    expect(repo.elements.get(precisionKey('ex1'))).toBeUndefined()
    expect(sketchPrecision(repo, 'ex1')).toBeNull()
  })

  it('clears the record with the feature registrations', () => {
    const repo = initGlobalRepo()
    postRegister(repo, 'sk1', { id: 'sk1', kind: 'sketch' }, {
      status: 'ok', angular_miss: 3e-11, linear_miss: 4e-9,
    })
    clearFeatureGeometryRegistrations(repo, 'sk1')
    expect(repo.elements.get(precisionKey('sk1'))).toBeUndefined()
  })

  it('never fabricates a record from an unknown solve id', () => {
    const repo = initGlobalRepo()
    expect(sketchPrecision(repo, 'missing')).toBeNull()
    expect(sketchPrecision(repo, '')).toBeNull()
    expect(precisionOfSolve({ body_id: 'b' } as Record<string, unknown>, 'sk1')).toBeNull()
  })

  it('drops a record whose display name is not a string', () => {
    const repo = initGlobalRepo()
    repo.register(precisionKey('sk1'), {
      angular: 3e-11, linear: 4e-7, sketch: 'sk1', sketch_name: 3,
    })
    expect(sketchPrecision(repo, 'sk1')).toBeNull()
  })

  it('carries the weak flag from the solve through the repo record', () => {
    // The flag is what lets an extrude's ceiling warning point at the sketch's
    // own weak warning instead of reading as the cause itself.
    expect(precisionOfSolve({
      angular_miss: 1.05e-8, linear_miss: 7.4e-8,
      weak_constraints: [{ constraintId: 'c1', moveEstimate: 0.045 }],
    }, 'sk1')).toEqual({ ...p(1.05e-8, OCC_CONFUSION, 'sk1'), weak: true })
    const repo = initGlobalRepo()
    postRegister(repo, 'sk1', { id: 'sk1', kind: 'sketch' }, {
      status: 'fully_constrained',
      angular_miss: 1.05e-8,
      linear_miss: 7.4e-8,
      weak_constraints: [{ constraintId: 'c1', moveEstimate: 0.045 }],
    })
    expect(sketchPrecision(repo, 'sk1')?.weak).toBe(true)
    // A weak-free solve reads exactly as before (no `weak` key).
    expect(precisionOfSolve({ angular_miss: 3e-11, linear_miss: 2e-7 }, 'sk1')).toEqual({
      ...p(3e-11, 2e-7, 'sk1'),
    })
  })

  it('keeps the weak flag with the sketch that dominates the max', () => {
    expect(maxPrecision(p(1e-9, 1e-9, 'sk1'), { ...p(3e-9, 1e-9, 'sk2'), weak: true }))
      .toEqual({ ...p(3e-9, 1e-9, 'sk2'), weak: true })
    // The weaker-but-not-dominating record's flag does not travel.
    expect(maxPrecision({ ...p(3e-9, 1e-9, 'sk1'), weak: true }, p(1e-9, 1e-9, 'sk2')))
      .toEqual({ ...p(3e-9, 1e-9, 'sk1'), weak: true })
  })
})
