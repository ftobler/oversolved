// @vitest-environment node
//
// The feature-outcome vocabulary without the kernel: which status words count
// as a problem, how a solve response is read, and how the problem list is
// ordered and worded. The table is the whole solver status union, so a new
// word cannot be added to the kernel and silently disappear from the reply.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  featureProblems,
  formatFeatureProblem,
  isFeatureProblem,
  MISSING_VERDICT_MESSAGE,
  readSolveOutcomes,
  type FeatureOutcome,
} from '../featureOutcome'

// BodyFeatureResult's status union, the sketch solver's STATUS_NAME verdicts,
// builder's suppressed marker, and extrude/revolve's no-profile word. The
// expected column is the contract: a pass or a chosen state is not a problem.
const STATUS_TABLE: Array<[string, boolean]> = [
  ['ok', false],
  ['fully_constrained', false],
  ['underconstrained', false],
  ['suppressed', false],
  ['partial', true],
  ['exception', true],
  ['error', true],
  ['overconstrained', true],
]

describe('isFeatureProblem', () => {
  it.each(STATUS_TABLE)('reads %s as a problem: %s', (status, problem) => {
    expect(isFeatureProblem({ status })).toBe(problem)
  })

  it('counts a warning on an otherwise good solve as a problem', () => {
    expect(isFeatureProblem({ status: 'ok', warning: 'hole: nothing was removed' })).toBe(true)
    expect(isFeatureProblem({ status: 'fully_constrained', warning: 'sketch: fallback' })).toBe(true)
  })

  it('counts an unrecognised status as a problem', () => {
    expect(isFeatureProblem({ status: 'some-future-status' })).toBe(true)
  })
})

describe('readSolveOutcomes', () => {
  it('keeps the status plus the kernel exception and warning text', () => {
    expect(readSolveOutcomes({
      sk1: { status: 'underconstrained' },
      h1: { status: 'exception', exception: 'hole: no drill site' },
      f1: { status: 'partial', exception: '1/2 sites missed', solver_warning: 'skipped a face' },
      junk: null,
      noStatus: { geometry: {} },
      emptyText: { status: 'ok', exception: '', solver_warning: '' },
    })).toEqual({
      sk1: { status: 'underconstrained' },
      h1: { status: 'exception', exception: 'hole: no drill site' },
      f1: { status: 'partial', exception: '1/2 sites missed', warning: 'skipped a face' },
      emptyText: { status: 'ok' },
    })
  })

  it('keeps a hole\'s resolved drill side and ignores any other value there', () => {
    expect(readSolveOutcomes({
      h1: { status: 'ok', direction: 'reverse' },
      h2: { status: 'ok', direction: 'normal' },
      ex1: { status: 'ok', direction: 'symmetric' },
    })).toEqual({
      h1: { status: 'ok', direction: 'reverse' },
      h2: { status: 'ok', direction: 'normal' },
      ex1: { status: 'ok' },
    })
  })

  it('is empty for a missing result', () => {
    expect(readSolveOutcomes(undefined)).toEqual({})
    expect(readSolveOutcomes(null)).toEqual({})
  })
})

function problemDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'h1', kind: 'hole' },
      { id: 'f1', kind: 'fillet' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'gon', kind: 'sketch', suppressed: true },
    ],
  } as PartDoc
}

describe('featureProblems', () => {
  const outcomes: Record<string, FeatureOutcome> = {
    sk1: { status: 'underconstrained' },
    h1: { status: 'exception', exception: "hole: sketch 'sk3' has no point or circle entities" },
    f1: { status: 'ok', warning: 'fillet: the radius was clamped' },
    sk2: { status: 'overconstrained' },
    ex1: { status: 'error', exception: 'extrude: no closed profile found' },
    gon: { status: 'suppressed' },
  }

  it('lists only the problems, in feature log order, with kind and message', () => {
    expect(featureProblems(problemDoc(), outcomes)).toEqual([
      { id: 'h1', kind: 'hole', status: 'exception', message: "hole: sketch 'sk3' has no point or circle entities" },
      { id: 'f1', kind: 'fillet', status: 'ok', message: 'fillet: the radius was clamped' },
      { id: 'sk2', kind: 'sketch', status: 'overconstrained', message: 'the sketch is overconstrained' },
      { id: 'ex1', kind: 'extrude', status: 'error', message: 'extrude: no closed profile found' },
    ])
  })

  it('reports a feature the solve did not reach as a missing verdict', () => {
    // The wedge signature: a solve returns an empty result, so every authored
    // feature is absent. That must read as a problem, not as a clean build.
    expect(featureProblems(problemDoc(), {
      sk1: { status: 'fully_constrained' },
      h1: { status: 'ok' },
    })).toEqual([
      { id: 'f1', kind: 'fillet', status: 'missing', message: MISSING_VERDICT_MESSAGE },
      { id: 'sk2', kind: 'sketch', status: 'missing', message: MISSING_VERDICT_MESSAGE },
      { id: 'ex1', kind: 'extrude', status: 'missing', message: MISSING_VERDICT_MESSAGE },
    ])
    // The suppressed feature is exempt whether or not the builder reached it.
    expect(featureProblems(problemDoc(), {})).not.toContainEqual(
      expect.objectContaining({ id: 'gon' }),
    )
  })

  it('does not require a verdict for a builtin display feature', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'ex1', kind: 'extrude' },
        { id: 'Top', kind: 'plane' },
      ],
    } as PartDoc
    expect(featureProblems(doc, { ex1: { status: 'ok' } })).toEqual([])
  })

  it('formats one problem for the one-line summary', () => {
    expect(formatFeatureProblem({ id: 'h1', kind: 'hole', status: 'exception', message: 'boom' }))
      .toBe('h1 (hole) exception: boom')
  })
})
