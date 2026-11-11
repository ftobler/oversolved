import { nonNegative, positive, type ValueRule } from './valueRules'
import { pointDistanceZeroProblem } from '@/utils/yamlMutations/helpers'
import type { ConstraintKindName } from '@/wasm-kernel/codec'

// The dimension kinds whose solver row stays a real constraint at 0: the axis
// distances and the radial gap have an analytic row at the kink, so a zero
// value removes its degree of freedom and is authorable.
const ZERO_IS_A_DIMENSION: ReadonlySet<ConstraintKindName> = new Set([
  'point_distance_x',
  'point_distance_y',
  'radius_difference',
])

/** The edit-dialog rule for one dimension kind. A euclidean point_distance of
 *  0 asks for two coincident points, so it is refused with that hint; the
 *  kinds whose row is legal at 0 accept it; every other dimension keeps the
 *  strictly positive bound it always had. */
export function dimensionValueRule(kind: ConstraintKindName): ValueRule {
  if (kind === 'point_distance') {
    return (v) => (v === 0 ? pointDistanceZeroProblem(kind, v) : positive(v))
  }
  return ZERO_IS_A_DIMENSION.has(kind) ? nonNegative : positive
}
