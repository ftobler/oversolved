/**
 * Variable feature solver: a named value published into the parametric stack.
 *
 * A `variable` feature has no geometry. Its `label` is the variable name and its
 * `variable.expression` is a math formula that may reference earlier variables.
 * Solving evaluates the expression against the accumulated variable context (the
 * labels + values of all preceding variable features) and returns the numeric
 * `value` so downstream features can reference it by name in their own
 * expression fields.
 *
 * Pure: no OCC, no body store. The builder loop owns the context and threads it
 * in, so this stays trivially unit-testable.
 */

import { evalExpr } from '../evalExpr'

// mathjs constants that would shadow a builtin if used as a variable name.
const RESERVED = new Set(['pi', 'e', 'i', 'Infinity', 'NaN', 'true', 'false', 'null'])

/** True if `name` is a valid JS identifier and not a mathjs reserved constant.
 *  Variable labels become keys in the mathjs evaluate() scope, so they must obey
 *  identifier rules (letter/`_`/`$` start, alphanumeric/`_`/`$` rest). */
export function isValidVariableName(name: string): boolean {
  if (!name) return false
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false
  return !RESERVED.has(name)
}

/** Evaluate a variable feature's expression against the preceding-variable
 *  context. Returns `{ status: 'ok', value, expression }` on success, or
 *  `{ status: 'exception', exception }` for an invalid name, a duplicate name,
 *  a missing/empty expression, or an unevaluable formula. */
export function solveVariable(
  feature: Record<string, unknown>,
  context: Record<string, number> = {},
): Record<string, unknown> {
  const varName = String(feature.label ?? feature.id ?? '')

  // Defense in depth: the mutation layer also prevents these, but a hand-edited
  // doc (code mode) can still carry an invalid or colliding name.
  if (!isValidVariableName(varName)) {
    return { status: 'exception', exception: `Invalid variable name: "${varName}". Must be a valid identifier.` }
  }
  if (varName in context) {
    return { status: 'exception', exception: `Duplicate variable name: "${varName}". Variable names must be unique.` }
  }

  const variable = feature.variable as Record<string, unknown> | undefined
  const expression = variable?.expression
  // A plain number is a legal expression (stored numerically); coerce for eval.
  const exprStr = typeof expression === 'number' ? String(expression) : expression
  if (typeof exprStr !== 'string' || exprStr.trim() === '') {
    return { status: 'exception', exception: 'Variable has no expression' }
  }

  const value = evalExpr(exprStr, context)
  if (isNaN(value)) {
    return { status: 'exception', exception: `Cannot evaluate "${exprStr}"` }
  }
  return { status: 'ok', value, expression: exprStr }
}
