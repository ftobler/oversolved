/**
 * Math-expression evaluation for numeric input fields.
 *
 * Users type formulas (`2+2`, `sqrt(16)`, `width*2`) into any numeric field.
 * This module is pure and lives in the kernel so it is reachable from both the
 * UI (live preview while typing) and the solve pipeline (resolving stored
 * expression strings to numbers before leaf-solver dispatch).
 *
 * mathjs `evaluate()` is sandboxed by default: no access to `Function`, `eval`,
 * or prototype chains, so arbitrary expression strings from the document are
 * safe to evaluate.
 */

import { create, all } from 'mathjs'

const math = create(all, {})

/** Evaluate a math expression string with an optional variable context.
 *  Returns the numeric result, or NaN on any failure (empty, parse error,
 *  non-finite, non-numeric result, unknown variable). Callers decide how to
 *  surface NaN.
 */
export function evalExpr(expr: string, context: Record<string, number> = {}): number {
  const trimmed = expr.trim()
  if (trimmed === '') return NaN

  // Fast path: a plain number string never needs mathjs.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed)
  }

  try {
    const result = math.evaluate(trimmed, context)
    // Reject anything that is not a finite plain number (units, matrices,
    // complex, booleans, Infinity from div-by-zero).
    if (typeof result === 'number' && isFinite(result)) return result
    return NaN
  } catch {
    return NaN
  }
}

/** Expression-capable fields per feature kind. Only these keys are evaluated
 *  before solver dispatch; everything else passes through untouched. The values
 *  may be plain numbers (legacy docs) or expression strings.
 */
export const EXPR_FIELDS_BY_KIND: Record<string, string[]> = {
  extrude: ['distance'],
  revolve: ['angle'],
  fillet: ['radius'],
  chamfer: ['distance', 'angle'],
  hole: ['diameter', 'depth'],
  array: ['pitch_x', 'pitch_y', 'count_x', 'count_y'],
  circular_array: ['step_angle', 'count'],
  transform: ['rotation_angle', 'scale'],
  plane: ['offset', 'angle', 'rotation'],
  import_step: ['scale'],
}

/** Evaluate the expression-capable fields of a feature's sub-dict in place.
 *  String values are replaced by their evaluated number; plain numbers are left
 *  untouched. On a failed evaluation the original string is kept and a
 *  `<key>_error` entry is written so the solver layer can mark the feature
 *  errored.
 */
export function evalFeatureParams(
  sub: Record<string, unknown>,
  exprFields: string[],
  context: Record<string, number> = {},
): void {
  for (const key of exprFields) {
    const val = sub[key]
    if (typeof val !== 'string') continue  // numbers (and absent) pass through
    const result = evalExpr(val, context)
    if (isNaN(result)) {
      sub[`${key}_error`] = `Cannot evaluate "${val}"`
      continue
    }
    sub[key] = result
  }
}
