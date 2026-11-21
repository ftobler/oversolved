/**
 * The shared value rules: null accepts, a string is the reason the value is
 * refused (the field-mark contract of utils/core/statusMark.ts). Every place a
 * user types a number, a schema field, a viewport value dialog or a dimension
 * edit, refuses with these, so one bound always reads the same.
 */
import { evalExpr, exprRefusal } from '@/kernel/evalExpr'

export type ValueRule = (v: number) => string | null

export const positive: ValueRule = (v) => (v > 0 ? null : 'must be greater than 0')

export const nonNegative: ValueRule = (v) => (v >= 0 ? null : 'must be 0 or more')

export const finite: ValueRule = (v) => (Number.isFinite(v) ? null : 'must be a finite number')

/** Strictly between `lo` and `hi`, both excluded. */
export const between = (lo: number, hi: number): ValueRule => (v) =>
  (v > lo && v < hi ? null : `must be between ${lo} and ${hi}`)

/** The refusal for text that is not a number (or not an expression).
 *
 *  A caller that passes a variable scope (the feature editor does) gets the
 *  reason in the user's terms: which name is unknown, which names are usable,
 *  or that the name is defined later. Without a scope the plain sentence stays,
 *  for the callers that have no document log to read (a command argument, a
 *  sketch dimension). */
export function cannotEvaluate(
  text: string,
  context?: Record<string, number>,
  laterVariables?: Record<string, number>,
): string {
  const shown = text.trim()
  if (context === undefined) return `cannot evaluate "${shown}"`
  const failure = exprRefusal(shown, context, laterVariables)
  if (failure === null) return `cannot evaluate "${shown}"`
  switch (failure.kind) {
    case 'later':
      return `variable "${failure.name}" is defined below this feature; move it above this one`
    case 'unknown': {
      const names = Object.keys(context)
      return names.length === 0
        ? `unknown variable "${failure.name}"; no variables are defined above this feature`
        : `unknown variable "${failure.name}"; defined above this feature: ${names.join(', ')}`
    }
    case 'syntax':
      return `cannot evaluate "${shown}": write a variable by its bare name, e.g. width*2`
  }
}

/** Typed text as an expression, then the rule: the whole refusal decision for
 *  an expression box in one call. */
export function expressionRefusal(
  input: string,
  rule?: ValueRule,
  context?: Record<string, number>,
  laterVariables?: Record<string, number>,
): string | null {
  const v = evalExpr(input.trim(), context ?? {})
  if (isNaN(v)) return cannotEvaluate(input, context, laterVariables)
  return rule ? rule(v) : null
}
