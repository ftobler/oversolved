// @vitest-environment node
//
// The feature-outcome vocabulary without the kernel: which status words count
// as a problem, how a solve response is read, and how the problem list is
// ordered and worded. The table is the whole solver status union, so a new
// word cannot be added to the kernel and silently disappear from the reply.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  featureNotes,
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

  it('does not count an informational note as a problem', () => {
    // The tangent chain a blend ran along describes geometry the pick does
    // produce; a note must not turn a clean feature into a problem row.
    expect(isFeatureProblem({ status: 'ok', note: 'fillet: the picked edges continue along the tangent chain' })).toBe(false)
  })
})

describe('readSolveOutcomes', () => {
  it('keeps the status plus the kernel exception and warning text', () => {
    expect(readSolveOutcomes({
      sk1: { status: 'underconstrained' },
      h1: { status: 'exception', exception: 'hole: no drill site' },
      f1: { status: 'partial', exception: '1/2 sites missed', solver_warning: 'skipped a face' },
      fi1: { status: 'ok', solver_note: 'fillet: the whole chain' },
      junk: null,
      noStatus: { geometry: {} },
      emptyText: { status: 'ok', exception: '', solver_warning: '', solver_note: '' },
    })).toEqual({
      sk1: { status: 'underconstrained' },
      h1: { status: 'exception', exception: 'hole: no drill site' },
      f1: { status: 'partial', exception: '1/2 sites missed', warning: 'skipped a face' },
      fi1: { status: 'ok', note: 'fillet: the whole chain' },
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

describe('featureNotes', () => {
  const noteDoc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'f1', kind: 'fillet' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ],
  } as PartDoc
  const clean: Record<string, FeatureOutcome> = {
    sk1: { status: 'fully_constrained' },
    f1: { status: 'ok' },
    ex1: { status: 'ok' },
    sk2: { status: 'fully_constrained' },
  }

  it('names a feature note and a resolved warning, in feature log order', () => {
    // f1 built with an informational note; ex1's touch warning was resolved by
    // a later union. Both ride the note channel, and the problem list is empty.
    const outcomes: Record<string, FeatureOutcome> = {
      ...clean,
      f1: { status: 'ok', note: 'fillet: the picked edges continue along the tangent chain' },
      ex1: { status: 'ok', resolvedWarning: 'extrude: the new solid also touches body_ex2; add a boolean union' },
    }
    expect(featureNotes(noteDoc, outcomes)).toEqual([
      { ids: ['f1'], text: 'fillet: the picked edges continue along the tangent chain' },
      { ids: ['ex1'], text: 'extrude: the new solid also touches body_ex2; add a boolean union' },
    ])
    expect(featureProblems(noteDoc, outcomes)).toEqual([])
  })

  it('sorts a two-id conflict note at the later sketch', () => {
    const conflict = { ids: ['sk1', 'sk2'], text: 'sk1 and sk2 share the face query' }
    const outcomes: Record<string, FeatureOutcome> = {
      ...clean,
      ex1: { status: 'ok', note: 'extrude: the add removed nothing' },
    }
    // ex1 sorts between the two sketches, so the pair note belongs after it.
    expect(featureNotes(noteDoc, outcomes, [conflict]).map(note => note.ids)).toEqual([
      ['ex1'],
      ['sk1', 'sk2'],
    ])
  })

  it('keeps a note naming a feature the document no longer holds, at the end', () => {
    const gone = { ids: ['sk1', 'sk9'], text: 'a stale pair' }
    expect(featureNotes(noteDoc, {}, [gone])).toEqual([gone])
  })

  it('has nothing to say about a clean solve', () => {
    expect(featureNotes(noteDoc, clean)).toEqual([])
  })
})
