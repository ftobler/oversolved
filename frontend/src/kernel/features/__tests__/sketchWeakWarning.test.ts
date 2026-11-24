// @vitest-environment node
//
// The weak (second-order) constraint's user-facing half: the sentence, the tree
// mark, the drive row, and the tile/label marking. No kernel: the solve side is
// pinned in sketch-solver/src/solve/weak.rs, and these read the result shape the
// solve publishes.

import { describe, it, expect } from 'vitest'
import { weakConstraintNoun, weakConstraintWarning } from '@/utils/constraintProblems'
import { featureFailure } from '@/utils/core/featureFailure'
import {
  blocksExport,
  featureProblems,
  readSolveOutcomes,
} from '@/drive/featureOutcome'
import { precisionCeilingWarning } from '@/kernel/precision'
import type { PartDoc } from '@/types/cad'

const X_DIM = 'c_point_distance_x_OJPy7uYJ'

/** The report's sentence: an x distance 2 at the inner arc's extreme leaving a
 *  0.045 deg rotation. */
const sentence = weakConstraintWarning(weakConstraintNoun('point_distance_x', 2), 0.0454)

/** A part with one fully constrained sketch whose solve reported a weak row. */
function weakDoc(): PartDoc {
  return {
    version: 5,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 1, 0] },
        constraints: [],
      },
    ],
  } as unknown as PartDoc
}

function solveResult(): Record<string, unknown> {
  return {
    sk1: {
      status: 'fully_constrained',
      dof: 0,
      solver_warning: sentence,
      angular_miss: 1.0548e-8,
      linear_miss: 7.4e-8,
      weak_constraints: [{ constraintId: X_DIM, moveEstimate: 0.0454 }],
    },
  }
}

describe('weakConstraintWarning', () => {
  it('names the constraint by kind and value, never by id', () => {
    expect(sentence).toBe(
      "x distance 2 holds the profile only at the arc's extreme, so the profile can rotate by up to "
      + "0.045 deg. Constrain the line vertical, or dimension a point that is not at the arc's extreme.",
    )
    // No id-looking token, and not the raw uuid the API carries.
    expect(sentence).not.toContain(X_DIM)
    expect(sentence).not.toMatch(/[A-Za-z0-9_-]{16,}/)
  })

  it('names the y axis and other dimensions in their own words', () => {
    expect(weakConstraintNoun('point_distance_y', 3.5)).toBe('y distance 3.5')
    expect(weakConstraintNoun('length', 7)).toBe('length 7')
    expect(weakConstraintNoun(undefined, undefined)).toBe('constraint')
  })
})

describe('a weak sketch is a warning row, not a failure', () => {
  it('marks the tree row yellow with the sentence', () => {
    const mark = featureFailure('sk1', solveResult(), {})
    expect(mark.level).toBe('warning')
    expect(mark.message).toBe(sentence)
  })

  it('reaches the drive features list with the structured ids beside the message', () => {
    const outcomes = readSolveOutcomes(solveResult())
    const problems = featureProblems(weakDoc(), outcomes)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      id: 'sk1',
      kind: 'sketch',
      status: 'fully_constrained',
      message: sentence,
      weak: [{ constraintId: X_DIM, moveEstimate: 0.0454 }],
    })
    // A built sketch warning never fails a run or an export.
    expect(blocksExport(problems[0])).toBe(false)
  })

  it('does not mark a weak-free sketch', () => {
    const plain = { sk1: { status: 'fully_constrained', dof: 0 } }
    expect(featureFailure('sk1', plain, {})).toEqual({ failed: false, level: null, message: '' })
    expect(readSolveOutcomes(plain).sk1.weak).toBeUndefined()
  })
})

describe('the weak marking on a constraint', () => {
  it('names the dimension the same way as the sketch warning', () => {
    expect(weakConstraintWarning(weakConstraintNoun('point_distance_x', 2), 0.045)).toBe(sentence)
    // A symbol tile with no authored record falls back to its own name, so a
    // redundant/conflicting suffix still reads inside the sentence.
    expect(weakConstraintWarning('Horizontal (redundant)', 0.045)).toContain(
      'Horizontal (redundant) holds the profile only at the arc',
    )
  })
})

describe('the merge-ceiling warning points at a weak sketch', () => {
  it('appends the pointer clause only when the sketch is weak', () => {
    const weak = precisionCeilingWarning({
      angular: 3e-9,
      linear: 1e-7,
      sketch: 'sk1',
      sketch_name: 'sketch 1',
      weak: true,
    })
    expect(weak).toContain('near-coplanar faces may stay split')
    expect(weak).toContain('see the warning on sketch 1')
    // Without the flag the text names the sketch and carries no pointer.
    const plain = precisionCeilingWarning({ angular: 3e-9, linear: 1e-7, sketch: 'sk1', sketch_name: 'sketch 1' })
    expect(plain).toBe(
      "sketch 1 solved to 3e-9 rad, above the kernel's 1e-9 merge ceiling; near-coplanar faces may stay split",
    )
    // A record without a display name falls back to the noun, never the id.
    const unnamed = precisionCeilingWarning({ angular: 3e-9, linear: 1e-7, sketch: 'sk1' })
    expect(unnamed).toBe(
      "the sketch solved to 3e-9 rad, above the kernel's 1e-9 merge ceiling; near-coplanar faces may stay split",
    )
  })
})
