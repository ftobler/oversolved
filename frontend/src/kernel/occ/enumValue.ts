/**
 * Unwrap and compare opencascade.js embind enum values. The binding hands an
 * enum back as a raw number in some places and as a `{value}` box in others
 * (the same inconsistency ReadFile/Transfer in stepIo.ts work around), and
 * `TopAbs_ShapeEnum` members are typed opaquely. Both shapes unwrap to the
 * same number so callers can compare against a named enum member.
 */

/** The numeric value behind a raw enum number or a `{value}` box. */
export function enumVal(e: unknown): number {
  return typeof e === 'number' ? e : (e as { value: number }).value
}

/** Whether two embind enum values name the same member. */
export function sameEnum(a: unknown, b: unknown): boolean {
  return enumVal(a) === enumVal(b)
}
