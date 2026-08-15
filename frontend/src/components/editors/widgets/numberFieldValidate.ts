import type { NumberFieldDef } from './fieldTypes'

/** The one predicate the numeric widget hands to `ExpressionInput`.
 *
 *  A schema states its numeric contract in more than one place: `parse: 'int'`
 *  says the stored value must be a whole number, while `validate` carries the
 *  free-form range check. The widget commits through `parseFloat`, so unless
 *  every part of that contract is folded into a single predicate a value the
 *  schema rejects (`2.5` for an array count) still reaches the mutation. */
export function validateNumberFieldValue(field: NumberFieldDef, v: number): boolean {
  if (field.parse === 'int' && !Number.isInteger(v)) return false
  return field.validate ? field.validate(v) : true
}
