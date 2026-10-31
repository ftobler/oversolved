import type { NumberFieldDef, SchemaData } from './fieldTypes'

/** The one rule the numeric widget hands to `ExpressionInput`: null accepts
 *  the value, a string is the reason it is refused (the same contract as a
 *  pick field's `validatePick`). Schemas write `validate` with the shared rules
 *  in utils/core/valueRules.ts.
 *
 *  A schema states its numeric contract in more than one place: `parse: 'int'`
 *  says the stored value must be a whole number, `min` sets a declarative
 *  floor, and `validate` carries any remaining free-form check. The widget
 *  commits through `parseFloat`, so unless every part of that contract is
 *  folded into a single rule a value the schema rejects (`2.5` for an
 *  array count, or a count below its declared `min`) still reaches the
 *  mutation. `!(v >= field.min)` (rather than `v < field.min`) also catches
 *  NaN, which fails both comparisons. */
export function validateNumberFieldValue(field: NumberFieldDef, v: number, data?: SchemaData): string | null {
  if (field.parse === 'int' && !Number.isInteger(v)) return 'must be a whole number'
  if (field.min != null && !(v >= field.min)) return `must be at least ${field.min}`
  if (field.max != null && !(v <= field.max)) return `must be at most ${field.max}`
  const own = field.validate ? field.validate(v) : null
  if (own !== null || !field.validateWith || !data) return own
  return field.validateWith(v, data)
}
