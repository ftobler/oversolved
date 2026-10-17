/**
 * The shared value rules: null accepts, a string is the reason the value is
 * refused (the field-mark contract of utils/core/statusMark.ts). Every place a
 * user types a number, a schema field, a viewport value dialog or a dimension
 * edit, refuses with these, so one bound always reads the same.
 */
import { evalExpr } from '@/kernel/evalExpr'

export type ValueRule = (v: number) => string | null

export const positive: ValueRule = (v) => (v > 0 ? null : 'must be greater than 0')

export const nonNegative: ValueRule = (v) => (v >= 0 ? null : 'must be 0 or more')

export const finite: ValueRule = (v) => (Number.isFinite(v) ? null : 'must be a finite number')

/** Strictly between `lo` and `hi`, both excluded. */
export const between = (lo: number, hi: number): ValueRule => (v) =>
  (v > lo && v < hi ? null : `must be between ${lo} and ${hi}`)

/** The refusal for text that is not a number (or not an expression). */
export function cannotEvaluate(text: string): string {
  return `cannot evaluate "${text.trim()}"`
}

/** Typed text as an expression, then the rule: the whole refusal decision for
 *  an expression box in one call. */
export function expressionRefusal(input: string, rule?: ValueRule, context?: Record<string, number>): string | null {
  const v = evalExpr(input.trim(), context ?? {})
  if (isNaN(v)) return cannotEvaluate(input)
  return rule ? rule(v) : null
}
