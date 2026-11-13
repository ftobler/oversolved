// Which entity kinds a constraint kind can take, at the boundary where an
// authored row is judged against the kind its target currently has.
//
// The registry's `entityKindGroups` is the editor command's own pre-check: the
// action matrix pins exactly which picks it refuses, so that set stays as it is.
// The solve boundary needs a wider table. It also judges the kinds whose
// `apply_<kind>` command never had a pre-check (a length on an arc, a diameter on
// a line) and the rows those commands authored before this rule existed.
//
// One table, two readers: `addConstraintProblem` refuses a new pick with this
// sentence and `partDocToSketches` drops an authored row with the same one, so an
// author cannot author a row the next solve silently ignores. The two do not
// always see the same kind, and that is the point of the report: the add-time
// reader sees the kind the document DECLARES, the lowering sees the kind the
// solve RESOLVED (a projected entity can be a declared circle and a resolved
// ellipse). Until the in-process solve stops writing the resolved kind back into
// the entity def (`projection-lowering-hygiene`), a headless run tends to have
// the two agree; after it, a row authored on the declared kind can still be
// dropped by the solve, which is the reporting path this rule exists for.
//
// A projected entity re-resolves every solve (a circle becomes an ellipse, an arc
// a spline), which is why the lowering reader is the one that matters.

import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'

/**
 * Where an operand came from in the constraint row. The overloaded horizontal
 * and vertical take one line in `target`, or two points in `a`/`b`, so each form
 * is judged against its own group. `operand` is any other slot (the `line`/`arc`
 * of a tangent or midpoint, a locus in a `dock` lowering).
 */
export type ConstraintOperandRole = 'target' | 'a' | 'b' | 'operand'

/** One whole-entity operand of a constraint, with the field it came from. */
export interface ConstraintKindOperand {
  role: ConstraintOperandRole
  kind: string
}

/**
 * The kinds whose operand kinds no registry `entityKindGroups` entry names.
 * Every key is a registry constraint kind, and none may shadow a registry group
 * (the test checks both): where the registry speaks, its entry is the judgement
 * spelled beside the constraint, and duplicating it here would let the two drift.
 */
export const SOLVE_BOUNDARY_KIND_GROUPS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  horizontal: [['line']],  // the target form needs a line; the a/b pair is judged as points
  vertical: [['line']],  // same overload: one line in target, two points in a/b
  length: [['line']],  // params 0..3 are endpoints only on a line
  radius: [['arc', 'circle']],  // both store the radius at param 2
  diameter: [['arc', 'circle']],  // twice the radius at param 2
  angle: [['line']],  // both operands are measured as endpoint directions
  radius_difference: [['arc', 'circle']],  // the gap between two radii
}

/**
 * The overloaded kinds: `target` is the one-entity form (a line), `a`/`b` the
 * two-point form. The pair is judged against points, because the solver resolves
 * it through `point()`, where a whole point entity IS the point. A whole
 * non-point entity in the pair is the degenerate single-sub-point pick that
 * `dropDeadAxisConstraints` prunes, so it is refused here too.
 */
const OVERLOADED_AXIS_KINDS: ReadonlySet<string> = new Set(['horizontal', 'vertical'])
const AXIS_PAIR_KIND_GROUPS: readonly (readonly string[])[] = [['point']]

/** The groups a constraint kind accepts at the solve boundary: the registry's
 *  entry where it has one, the boundary table otherwise. */
export function constraintEntityKindGroups(
  kind: string,
): readonly (readonly string[])[] | undefined {
  return CONSTRAINT_BY_KIND.get(kind)?.entityKindGroups ?? SOLVE_BOUNDARY_KIND_GROUPS[kind]
}

/**
 * Why `kind` cannot take exactly these whole-entity operands, or null when it
 * can. Only operands that name a WHOLE entity are passed (a vertex, the origin
 * and an unmaterialized handle are point operands); every one of them must fall
 * in one common group. The overloaded horizontal/vertical are the exception:
 * their `target` form and their `a`/`b` pair are judged separately, because the
 * pair is two points and the target one line.
 *
 * The sentence is the `dropped_constraints` reason and the add-time refusal, so a
 * script can recognise the row a later solve ignores. It names the operands'
 * current kinds rather than the kind they were authored for: that is the rule
 * that re-validates the rows on a projected entity after its kind changes.
 *
 * An empty list or a constraint without groups is not a refusal: a coincident on
 * two vertices still lowers, and the heterogeneous and role-dependent
 * constraints (tangent, normal, midpoint, line_distance) gate their own kinds in
 * the solver.
 */
export function constraintEntityKindProblem(
  kind: string,
  operands: readonly ConstraintKindOperand[],
): string | null {
  const groups = constraintEntityKindGroups(kind)
  if (!groups || operands.length === 0) return null
  const verdict = (
    judged: readonly ConstraintKindOperand[],
    against: readonly (readonly string[])[] = groups,
  ): string | null => {
    if (judged.length === 0) return null
    if (against.some(group => judged.every(operand => group.includes(operand.kind)))) return null
    return `${kind} does not apply to ${[...new Set(judged.map(operand => operand.kind))].join(' and ')}`
  }
  if (OVERLOADED_AXIS_KINDS.has(kind)) {
    // Judge each form by its own role: the target form is a line, the a/b pair
    // two points. An empty side is not a refusal (the shape rules own a missing
    // or mixed pick).
    const targetProblem = verdict(operands.filter(operand => operand.role === 'target'))
    if (targetProblem !== null) return targetProblem
    return verdict(
      operands.filter(operand => operand.role === 'a' || operand.role === 'b'),
      AXIS_PAIR_KIND_GROUPS,
    )
  }
  return verdict(operands)
}
