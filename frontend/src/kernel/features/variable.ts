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

import type { PartFeature } from '@/types/cad'
import { evalExpr, laterVariableRef } from '../evalExpr'

// mathjs constants that would shadow a builtin if used as a variable name.
const RESERVED = new Set(['pi', 'e', 'i', 'Infinity', 'NaN', 'true', 'false', 'null'])

// The one identifier shape both name checks read: a letter, `_` or `$` start,
// then the same set plus digits.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Replace invalid identifier chars with `_`, prefix leading digits, fallback to `var`.
 *  Shared by `add_variable` (which rewrites a name silently) and the rename
 *  hint (which suggests the same name it would create). */
export function sanitizeIdentifier(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, '_')
  // All-underscore (or empty) carries no meaningful name: fall back to `var`.
  if (!/[A-Za-z0-9$]/.test(cleaned)) return 'var'
  if (/^[0-9]/.test(cleaned)) return 'var_' + cleaned
  return cleaned
}

/** True if `name` is a valid JS identifier and not a mathjs reserved constant.
 *  Variable labels become keys in the mathjs evaluate() scope, so they must obey
 *  identifier rules (letter/`_`/`$` start, alphanumeric/`_`/`$` rest). */
export function isValidVariableName(name: string): boolean {
  if (!name) return false
  if (!IDENTIFIER.test(name)) return false
  return !RESERVED.has(name)
}

/** Why `name` cannot be variable `featureId`'s new label, or null when it can.
 *  The rename applier, the rename dialog and the MCP reply all read this one
 *  sentence, so the user sees the same words wherever the rename is refused. */
export function variableRenameProblem(
  features: readonly PartFeature[],
  featureId: string,
  name: string,
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'A variable needs a name.'
  if (!IDENTIFIER.test(trimmed)) {
    if (/^[0-9]/.test(trimmed)) {
      return `"${trimmed}" is not a valid variable name: it must start with a letter or _.`
    }
    return invalidVariableNameProblem(trimmed)
  }
  if (RESERVED.has(trimmed)) {
    return `"${trimmed}" is a built-in constant and cannot name a variable.`
  }
  const collision = features.some(
    f => f.id !== featureId && f.kind === 'variable' && f.label === trimmed,
  )
  if (collision) return `A variable named "${trimmed}" already exists.`
  return null
}

function invalidVariableNameProblem(name: string): string {
  return `"${name}" is not a valid variable name: use letters, digits and _ only `
    + `(a - reads as minus in an expression). Try "${sanitizeIdentifier(name)}".`
}

/** Evaluate a variable feature's expression against the preceding-variable
 *  context. Returns `{ status: 'ok', value, expression }` on success, or
 *  `{ status: 'exception', exception }` for an invalid name, a duplicate name,
 *  a missing/empty expression, or an unevaluable formula. */
export function solveVariable(
  feature: Record<string, unknown>,
  context: Record<string, number> = {},
  laterVariables: Record<string, number> = {},
): Record<string, unknown> {
  const varName = String(feature.label ?? feature.id ?? '')

  // Defense in depth: the mutation layer refuses an invalid or colliding rename
  // with a message, but a hand-edited or imported doc can still carry one.
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
    const later = laterVariableRef(exprStr, laterVariables)
    if (later !== null) {
      return {
        status: 'exception',
        exception:
          `expression: variable '${later.name}' is defined after this feature (at index ${later.index}); ` +
          'move it up with reorder_features',
      }
    }
    return { status: 'exception', exception: `Cannot evaluate "${exprStr}"` }
  }
  return { status: 'ok', value, expression: exprStr }
}
