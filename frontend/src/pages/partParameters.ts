// The parameter table's model: every `variable` feature as one row of
// name / expression / unit / value, plus the mutation an edited cell writes.
//
// The document owns the name (the feature's label), the expression and the unit
// hint; the VALUE is solve output, shown read-only. Pure, so the table's
// behaviour is testable without the dialog (the dialog renders exactly these
// rows and dispatches exactly these mutations).

import type { Mutation, PartFeature, SketchData } from '@/types/cad'

export interface ParameterRow {
  id: string
  name: string
  expression: string
  unit: string
  // The solved value, or null when the solve has not landed / failed.
  value: number | null
  // The variable's own solve error, if its expression did not evaluate.
  error: string | null
}

/** The unit hints the table offers. A unit is a display hint (no conversion is
 *  applied anywhere), so the list is a convenience, not a closed set: a doc that
 *  carries another string keeps it. */
export const UNIT_OPTIONS: readonly string[] = ['', 'mm', 'cm', 'in', 'deg', 'rad']

/** The rows the table shows, in document order (a variable's expression may
 *  reference an earlier variable, so the order is meaningful). */
export function parameterRows(
  features: readonly PartFeature[],
  solveResults: Readonly<Record<string, SketchData>> | undefined,
): ParameterRow[] {
  const rows: ParameterRow[] = []
  for (const feature of features) {
    if (feature.kind !== 'variable') continue
    const result = solveResults?.[feature.id]
    rows.push({
      id: feature.id,
      name: feature.label ?? feature.id,
      expression: String(feature.variable?.expression ?? ''),
      unit: feature.variable?.unit ?? '',
      value: typeof result?.value === 'number' && Number.isFinite(result.value) ? result.value : null,
      error: typeof result?.exception === 'string' && result.exception !== '' ? result.exception : null,
    })
  }
  return rows
}

/** The value column's text: the solved number, or what is wrong with it. */
export function parameterValueText(row: ParameterRow): string {
  if (row.error !== null) return row.error
  if (row.value === null) return '...'
  return String(Number(row.value.toFixed(6)))
}

/** The mutations one edited cell writes. `field` picks the column; an empty
 *  name or unit clears the field rather than storing a blank string, and the
 *  expression is stored verbatim (the solver evaluates it, and `0`/`''` is
 *  refused there by name). */
export function parameterEditMutations(row: ParameterRow, field: 'name' | 'expression' | 'unit', value: string): Mutation[] {
  if (field === 'name') {
    const name = value.trim()
    if (name === '') return []
    return [{ type: 'rename_feature', featureId: row.id, label: name }]
  }
  const stored = value === '' ? null : value
  return [{ type: 'set_variable_field', featureId: row.id, field, value: stored }]
}

/** The mutation that appends a new parameter, under a name the caller minted a
 *  feature id for. `add_variable` de-duplicates the name against the existing
 *  variables, so a fresh row is always addressable. */
export function newParameterMutation(featureId: string, name: string): Mutation {
  return { type: 'add_variable', featureId, label: name }
}
