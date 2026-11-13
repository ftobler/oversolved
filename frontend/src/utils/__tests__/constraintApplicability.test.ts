import { describe, it, expect } from 'vitest'
import { CONSTRAINTS, CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import {
  SOLVE_BOUNDARY_KIND_GROUPS,
  constraintEntityKindGroups,
  constraintEntityKindProblem,
  type ConstraintKindOperand,
  type ConstraintOperandRole,
} from '@/utils/constraintApplicability'

/** One whole-entity operand, `target` unless a caller says otherwise. */
const at = (kind: string, role: ConstraintOperandRole = 'target'): ConstraintKindOperand => ({ role, kind })

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
    expect(constraintEntityKindGroups('concentric')).toEqual([['arc', 'circle', 'ellipse']])
    expect(constraintEntityKindGroups('length')).toEqual([['line']])
    expect(constraintEntityKindGroups('coincident')).toBeUndefined()
  })

  it('judges one common group over every whole-entity operand', () => {
    // The add-time guards and the solve-time lowering both read this, so the
    // verdict is one sentence with the offending kinds in operand order.
    expect(constraintEntityKindProblem('length', [at('line')])).toBeNull()
    expect(constraintEntityKindProblem('length', [at('arc')])).toBe('length does not apply to arc')
    expect(constraintEntityKindProblem('radius', [at('circle')])).toBeNull()
    expect(constraintEntityKindProblem('radius', [at('ellipse')]))
      .toBe('radius does not apply to ellipse')
    expect(constraintEntityKindProblem('diameter', [at('arc')])).toBeNull()
    expect(constraintEntityKindProblem('diameter', [at('ellipse')]))
      .toBe('diameter does not apply to ellipse')
    expect(constraintEntityKindProblem('angle', [at('line', 'a'), at('line', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('angle', [at('line', 'a'), at('circle', 'b')]))
      .toBe('angle does not apply to line and circle')
    expect(constraintEntityKindProblem('radius_difference', [at('arc', 'a'), at('circle', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('radius_difference', [at('line', 'a'), at('circle', 'b')]))
      .toBe('radius_difference does not apply to line and circle')
    expect(constraintEntityKindProblem('equal_length', [at('line', 'a'), at('line', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('equal_length', [at('arc', 'a'), at('circle', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('equal_length', [at('line', 'a'), at('ellipse', 'b')]))
      .toBe('equal_length does not apply to line and ellipse')
    // An ellipse shares its centre (params 0..1) with a circle or an arc, and
    // the solver's concentric gate accepts it.
    expect(constraintEntityKindProblem('concentric', [at('circle', 'a'), at('ellipse', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('concentric', [at('line', 'a'), at('circle', 'b')]))
      .toBe('concentric does not apply to line and circle')
  })

  it('judges the overloaded horizontal/vertical by role', () => {
    // The single-target form is a line; the a/b pair resolves two points through
    // `point()`, where a whole point entity is legal. A whole non-point in the
    // pair is the degenerate pick the dead-axis cleanup prunes.
    expect(constraintEntityKindProblem('vertical', [at('line')])).toBeNull()
    expect(constraintEntityKindProblem('vertical', [at('point')]))
      .toBe('vertical does not apply to point')
    expect(constraintEntityKindProblem('vertical', [at('point', 'a'), at('point', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('horizontal', [at('point', 'a'), at('point', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('vertical', [at('circle', 'a'), at('line', 'b')]))
      .toBe('vertical does not apply to circle and line')
  })

  it('accepts every kind for a constraint with no group and for no operand', () => {
    // A vertex, the origin and an unmaterialized handle are not entity operands:
    // a caller passes only whole entities, so an empty list is not a refusal (a
    // coincident on two vertices still lowers).
    expect(constraintEntityKindProblem('coincident', [at('line', 'a'), at('point', 'b')])).toBeNull()
    expect(constraintEntityKindProblem('horizontal', [])).toBeNull()
    expect(constraintEntityKindProblem('not_a_constraint', [at('circle')])).toBeNull()
  })
})
