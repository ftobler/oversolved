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
import type { FunctionNode, MathNode, SymbolNode } from 'mathjs'
import type {
  ArrayFeatureDef, BooleanFeatureDef, ChamferFeatureDef, CircularArrayFeatureDef,
  ExtrudeFeatureDef, FilletFeatureDef, HelixFeatureDef, HoleFeatureDef,
  ImportStepFeature, PlaneDef, RevolveFeatureDef, ShellFeatureDef, TransformFeatureDef, MoveFaceFeatureDef,
} from '@/types/cad'

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

/** The payload each expression-capable kind keeps its params in. `import_step`
 *  has no sub-def: its `scale` sits flat on the feature, so the honest entry
 *  there is the feature itself. */
interface ExprPayloads {
  extrude: ExtrudeFeatureDef
  revolve: RevolveFeatureDef
  fillet: FilletFeatureDef
  chamfer: ChamferFeatureDef
  shell: ShellFeatureDef
  move_face: MoveFaceFeatureDef
  hole: HoleFeatureDef
  array: ArrayFeatureDef
  circular_array: CircularArrayFeatureDef
  transform: TransformFeatureDef
  plane: PlaneDef
  helix: HelixFeatureDef
  import_step: ImportStepFeature
  boolean: BooleanFeatureDef
}

export type ExprFieldKind = keyof ExprPayloads

/** Expression-capable fields per feature kind. Only these keys are evaluated
 *  before solver dispatch; everything else passes through untouched. The values
 *  may be plain numbers (legacy docs) or expression strings. The mapped type
 *  pins each field name to a key of that kind's payload, so a renamed or
 *  mistyped def field is a build error instead of that field silently never
 *  being evaluated.
 */
export const EXPR_FIELDS_BY_KIND: { [K in ExprFieldKind]: readonly (keyof ExprPayloads[K] & string)[] } = {
  extrude: ['distance'],
  revolve: ['angle'],
  fillet: ['radius'],
  chamfer: ['distance', 'angle'],
  shell: ['thickness'],
  move_face: ['distance'],
  hole: ['diameter', 'depth', 'cb_diameter', 'cb_depth', 'cs_angle'],
  array: ['pitch_x', 'pitch_y', 'count_x', 'count_y'],
  circular_array: ['step_angle', 'count'],
  transform: ['rotation_angle', 'scale'],
  plane: ['offset', 'angle', 'rotation', 'rotation_angle'],
  helix: ['radius', 'pitch', 'turns', 'height', 'helix_angle', 'offset', 'start_angle'],
  import_step: ['scale'],
  boolean: ['clearance'],
}

/** Whether `kind` is one of the kinds in the expression table. Narrowing a raw
 *  (structurally unknown) kind with this is how the kernel indexes the table
 *  without widening its type. */
export function isExprFieldKind(kind: string): kind is ExprFieldKind {
  return Object.hasOwn(EXPR_FIELDS_BY_KIND, kind)
}

/**
 * The first symbol an expression reads that names a variable defined later in
 * the feature log, with that definition's index. mathjs parses the string, so
 * only real identifiers count: a name inside a string literal or a function
 * call's own name is never mistaken for a variable. Null when the expression
 * has no forward reference (or does not parse at all, which the evaluator
 * reports as its own failure).
 */
export function laterVariableRef(
  expr: string,
  laterVariables: Record<string, number> = {},
): { name: string; index: number } | null {
  if (Object.keys(laterVariables).length === 0) return null
  try {
    const node: MathNode = math.parse(expr)
    let found: { name: string; index: number } | null = null
    node.traverse((child, _path, parent) => {
      if (found !== null || child.type !== 'SymbolNode') return
      // `sqrt(x)` parses as a FunctionNode whose callee is a SymbolNode. That
      // symbol names a function, not a variable, so it must not win the match.
      if (parent.type === 'FunctionNode' && (parent as FunctionNode).fn === child) return
      const name = (child as SymbolNode).name
      if (Object.hasOwn(laterVariables, name)) found = { name, index: laterVariables[name] }
    })
    return found
  } catch {
    return null
  }
}

/** Evaluate the expression-capable fields of a feature's sub-dict in place.
 *  String values are replaced by their evaluated number; plain numbers are left
 *  untouched. On a failed evaluation the original string is kept and a
 *  `<key>_error` entry is written so the solver layer can mark the feature
 *  errored. A forward reference gets the actionable "defined after" sentence
 *  instead of the generic "Cannot evaluate", because `laterVariables` names
 *  those variables and their log indices.
 */
export function evalFeatureParams(
  sub: Record<string, unknown>,
  exprFields: readonly string[],
  context: Record<string, number> = {},
  laterVariables: Record<string, number> = {},
): void {
  for (const key of exprFields) {
    const val = sub[key]
    if (typeof val !== 'string') continue  // numbers (and absent) pass through
    const result = evalExpr(val, context)
    if (isNaN(result)) {
      const later = laterVariableRef(val, laterVariables)
      sub[`${key}_error`] = later === null
        ? `Cannot evaluate "${val}"`
        : `${key}: variable '${later.name}' is defined after this feature (at index ${later.index}); `
          + 'move it up with reorder_features'
      continue
    }
    sub[key] = result
  }
}
