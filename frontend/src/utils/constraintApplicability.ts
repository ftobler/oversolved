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
// author cannot rely on a row the next solve silently ignores. A projected
// entity re-resolves every solve (a circle becomes an ellipse, an arc a spline),
// which is what makes the reader at the lowering the one that matters.

import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'

/**
 * The kinds whose operand kinds no registry `entityKindGroups` entry names.
 * Every key is a registry constraint kind, and none may shadow a registry group
 * (the test checks both): where the registry speaks, its entry is the judgement
 * spelled beside the constraint, and duplicating it here would let the two drift.
 */
export const SOLVE_BOUNDARY_KIND_GROUPS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  horizontal: [['line']],  // the one-entity form needs a line; two points carry no entity
  vertical: [['line']],  // same overload: one line, or two points
  length: [['line']],  // params 0..3 are endpoints only on a line
  radius: [['arc', 'circle']],  // both store the radius at param 2
  diameter: [['arc', 'circle']],  // twice the radius at param 2
  angle: [['line']],  // both operands are measured as endpoint directions
  radius_difference: [['arc', 'circle']],  // the gap between two radii
}

/** The groups a constraint kind accepts at the solve boundary: the registry's
 *  entry where it has one, the boundary table otherwise. */
export function constraintEntityKindGroups(
  kind: string,
): readonly (readonly string[])[] | undefined {
  return CONSTRAINT_BY_KIND.get(kind)?.entityKindGroups ?? SOLVE_BOUNDARY_KIND_GROUPS[kind]
}

/**
 * Why `kind` cannot take exactly these whole-entity operand kinds, or null when
 * it can. `entityKinds` holds only operands that name a WHOLE entity (a vertex,
 * the origin and an unmaterialized handle are point operands and are not passed);
 * every one of them must fall in one common group.
 *
 * The sentence is the `dropped_constraints` reason and the add-time refusal, so a
 * script can recognise the row a later solve ignores. It names the operands'
 * current kinds rather than the kind they were authored for: that is the rule
 * that re-validates the rows on a projected entity after its kind changes.
 *
 * An empty list or a constraint without groups is not a refusal: a coincident on
 * two vertices still lowers, and the heterogeneous constraints (tangent, normal)
 * gate their own kinds in the solver.
 */
export function constraintEntityKindProblem(
  kind: string,
  entityKinds: readonly string[],
): string | null {
  const groups = constraintEntityKindGroups(kind)
  if (!groups || entityKinds.length === 0) return null
  if (groups.some(group => entityKinds.every(entityKind => group.includes(entityKind)))) return null
  return `${kind} does not apply to ${[...new Set(entityKinds)].join(' and ')}`
}
