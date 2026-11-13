import { describe, it, expect } from 'vitest'
import { CONSTRAINTS, CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import {
  SOLVE_BOUNDARY_KIND_GROUPS,
  constraintEntityKindGroups,
  constraintEntityKindProblem,
} from '@/utils/constraintApplicability'

describe('constraint entity-kind applicability', () => {
  it('names only entity kinds the registry defines', () => {
    // A group is a whitelist of current kinds; a typo would reject every target
    // of a real kind instead of the one the table meant to refuse.
    const groups: Array<readonly string[]> = []
    for (const row of Object.values(SOLVE_BOUNDARY_KIND_GROUPS)) groups.push(...row)
    for (const constraint of CONSTRAINTS) groups.push(...(constraint.entityKindGroups ?? []))
    for (const group of groups) {
      for (const kind of group) {
        expect(ENTITY_BY_KIND.has(kind), `unknown entity kind ${kind}`).toBe(true)
      }
    }
  })

  it('only extends kinds the registry leaves ungrouped', () => {
    // The registry entry is the judgement spelled beside the constraint and the
    // editor command's pre-check. An extension for the same kind would be a
    // second, silently different answer.
    for (const kind of Object.keys(SOLVE_BOUNDARY_KIND_GROUPS)) {
      expect(CONSTRAINT_BY_KIND.has(kind), kind).toBe(true)
      expect(CONSTRAINT_BY_KIND.get(kind)?.entityKindGroups, kind).toBeUndefined()
    }
  })

  it('reads the registry group where one exists and the boundary table otherwise', () => {
    expect(constraintEntityKindGroups('parallel')).toEqual([['line']])
    expect(constraintEntityKindGroups('length')).toEqual([['line']])
    expect(constraintEntityKindGroups('coincident')).toBeUndefined()
  })

  it('judges one common group over every whole-entity operand', () => {
    // The add-time guards and the solve-time lowering both read this, so the
    // verdict is one sentence with the offending kinds in operand order.
    expect(constraintEntityKindProblem('vertical', ['line'])).toBeNull()
    expect(constraintEntityKindProblem('vertical', ['point']))
      .toBe('vertical does not apply to point')
    expect(constraintEntityKindProblem('length', ['arc'])).toBe('length does not apply to arc')
    expect(constraintEntityKindProblem('radius', ['circle'])).toBeNull()
    expect(constraintEntityKindProblem('radius', ['ellipse']))
      .toBe('radius does not apply to ellipse')
    expect(constraintEntityKindProblem('diameter', ['arc'])).toBeNull()
    expect(constraintEntityKindProblem('diameter', ['ellipse']))
      .toBe('diameter does not apply to ellipse')
    expect(constraintEntityKindProblem('angle', ['line', 'line'])).toBeNull()
    expect(constraintEntityKindProblem('angle', ['line', 'circle']))
      .toBe('angle does not apply to line and circle')
    expect(constraintEntityKindProblem('radius_difference', ['arc', 'circle'])).toBeNull()
    expect(constraintEntityKindProblem('radius_difference', ['line', 'circle']))
      .toBe('radius_difference does not apply to line and circle')
    expect(constraintEntityKindProblem('equal_length', ['line', 'line'])).toBeNull()
    expect(constraintEntityKindProblem('equal_length', ['arc', 'circle'])).toBeNull()
    expect(constraintEntityKindProblem('equal_length', ['line', 'ellipse']))
      .toBe('equal_length does not apply to line and ellipse')
    expect(constraintEntityKindProblem('concentric', ['circle', 'ellipse']))
      .toBe('concentric does not apply to circle and ellipse')
  })

  it('accepts every kind for a constraint with no group and for no operand', () => {
    // A vertex, the origin and an unmaterialized handle are not entity operands:
    // a caller passes only whole entities, so an empty list is not a refusal (a
    // coincident on two vertices still lowers).
    expect(constraintEntityKindProblem('coincident', ['line', 'point'])).toBeNull()
    expect(constraintEntityKindProblem('horizontal', [])).toBeNull()
    expect(constraintEntityKindProblem('not_a_constraint', ['circle'])).toBeNull()
  })
})
