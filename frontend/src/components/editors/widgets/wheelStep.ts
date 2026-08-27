/** The commit-shaped plain-number test. Deliberately the SAME regex
 *  ExpressionInput commits with, so anything this module steps is guaranteed
 *  to travel ExpressionInput's plain-number branch on the way out. */
export const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/** `text` stepped by exactly `dir`, or null when `text` is not a plain
 *  number (empty, an expression, a half-typed "1."). The step is the constant
 *  1; it never scales with the field's magnitude, decimals, `min`, or the
 *  wheel's `deltaY`. */
export function stepPlainNumber(text: string, dir: 1 | -1): number | null {
  const t = text.trim()
  if (!PLAIN_NUMBER.test(t)) return null
  return parseFloat(t) + dir
}
