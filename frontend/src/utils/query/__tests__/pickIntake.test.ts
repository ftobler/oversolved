/**
 * The pick field's intake planner. A field holds identities, not selection
 * strings: a part field wants the body a pick lands on, every other field wants
 * the stored form of the id. These pin what one arriving selection batch (a
 * click is one, a lasso is many) does to the field's held values, so the same
 * rules serve Delete Part, transform and the boolean fields.
 */
import { describe, it, expect } from 'vitest'
import type { PartResult } from '@/types/cad'
import { partsWantKey, identityWantKey, planPickIntake } from '../pickIntake'
import { stripSelectionWrapper } from '../selectionId'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })

const PARTS: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
  body_ex1_1: part('body_ex1_1', 'ex1'),
}

const want = partsWantKey(PARTS)

describe('partsWantKey', () => {
  it('maps a face or edge pick to the body that owns it', () => {
    expect(want('@body_ex1/edge/0')).toEqual({ keys: ['body_ex1'] })
    expect(want('face:ex1:?9;@body_ex1:face')).toEqual({ keys: ['body_ex1'] })
  })

  it('maps a feature ref to every body the feature made, sorted', () => {
    expect(want('@ex1')).toEqual({ keys: ['body_ex1', 'body_ex1_1'] })
  })

  it('refuses a pick that names no body', () => {
    expect(want('@builtin_plane_top')).toEqual({ refused: 'pick a face, edge or part' })
    expect(want('entity:sk1:l1')).toEqual({ refused: 'pick a face, edge or part' })
  })
})

describe('planPickIntake', () => {
  it('a lasso over two edges of one part adds the part once', () => {
    const intake = planPickIntake(
      ['@body_ex1/edge/0', '@body_ex1/edge/1'],
      [],
      want,
    )
    expect(intake).toEqual({ add: ['@body_ex1/edge/0'], remove: [], refused: [] })
  })

  it('a later click on another edge of a held part removes it', () => {
    // The user's scenario: the chip holds an edge of part 1, the next click is a
    // different edge of the same part, and that counts as the removal pick.
    const intake = planPickIntake(
      ['@body_ex1/edge/1'],
      ['@body_ex1/edge/0'],
      want,
    )
    expect(intake).toEqual({ add: [], remove: [0], refused: [] })
  })

  it('a lasso only adds: a held part is skipped, not toggled out', () => {
    const intake = planPickIntake(
      ['@body_ex1/edge/1', '@body_ex2/face/0'],
      ['@body_ex1/edge/0'],
      want,
    )
    expect(intake).toEqual({ add: ['@body_ex2/face/0'], remove: [], refused: [] })
  })

  it('refuses a pick that names no body and keeps the reason', () => {
    const intake = planPickIntake(['@builtin_plane_top'], [], want)
    expect(intake).toEqual({ add: [], remove: [], refused: ['pick a face, edge or part'] })
  })

  it('refuses a body inside a held plural value instead of dropping its siblings', () => {
    // @ex1 names every body the feature made; removing it for one sibling would
    // drop the split siblings too, so the click is refused by name instead.
    const intake = planPickIntake(
      ['@body_ex1_1/face/0'],
      ['@ex1'],
      want,
      { labelOf: () => 'Extrude 1 (all parts)' },
    )
    expect(intake).toEqual({ add: [], remove: [], refused: ['already in Extrude 1 (all parts)'] })
  })

  it('falls back to the held value when the field has no label', () => {
    const intake = planPickIntake(['@body_ex1_1/face/0'], ['@ex1'], want)
    expect(intake.refused).toEqual(['already in @ex1'])
  })

  it('an identity field keeps the exact-string toggle', () => {
    const identity = identityWantKey()
    expect(planPickIntake(['?9;@body_ex1:face'], ['?9;@body_ex1:face'], identity))
      .toEqual({ add: [], remove: [0], refused: [] })
    expect(planPickIntake(['?10;@body_ex1:face'], ['?9;@body_ex1:face'], identity))
      .toEqual({ add: ['?10;@body_ex1:face'], remove: [], refused: [] })
  })

  it('a transformed field removes on a re-click of the value it stored', () => {
    // KNOWN GAP closed: the stored value went through the field's transform, so
    // the clicked id is normalised the same way before comparing.
    const transformed = identityWantKey(stripSelectionWrapper)
    expect(planPickIntake(['entity:sk1:l1'], ['@sk1/l1'], transformed))
      .toEqual({ add: [], remove: [0], refused: [] })
  })

  it('a lasso over the same part through several faces is one undo-sized batch', () => {
    const intake = planPickIntake(
      ['face:ex1:?9;@body_ex1:face', 'face:ex1:?10;@body_ex1:face', '@body_ex1/edge/3'],
      [],
      want,
    )
    expect(intake.add).toEqual(['face:ex1:?9;@body_ex1:face'])
  })
})
