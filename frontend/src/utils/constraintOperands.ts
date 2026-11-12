// The operand sides a sketch constraint can name, shared by the mutation-time
// guard and the solver lowering. `colinear` is one of the kinds whose accepted
// shapes depend on what its two operands are (two lines, or a point and a
// line), so the applier, the drive rule and partDocToSketches must classify the
// same picks the same way or a document could store a shape the lowering drops.

import { resolveVertexRef } from '@/types/vertexRef'

/** Why a `colinear` operand pair has no solver row, or null when it lowers.
 *  The reason is the sentence the sketch warning and the drive refusal carry. */
export const COLINEAR_SHAPE_REASON = 'colinear needs two lines or a point and a line'

export type ConstraintOperandSide = 'line' | 'point' | 'curve' | 'unresolved'

/**
 * Which side one `colinear` operand names.
 *
 * - `line`: a bare line ref. The solver's collinear arm reads two of these as
 *   parallel plus one start on the other's line.
 * - `point`: a vertex of any entity, a bare point entity, the projected origin,
 *   or an `{external_xy}` ref. The solver reads it through `point()`.
 * - `curve`: a bare circle, arc, ellipse or spline. The solver would silently
 *   read its centre as a point (its coincident fallback), which is not what a
 *   colinear between a curve and a line means, so the pair is refused.
 * - `unresolved`: not a ref this sketch holds. The lowering reports it as a
 *   stale reference; it is not a shape error.
 */
export function constraintOperandSide(
  ref: unknown,
  entityIds: ReadonlySet<string>,
  kindById: ReadonlyMap<string, string>,
): ConstraintOperandSide {
  if (ref === '@builtin_origin') return 'point'
  if (ref !== null && typeof ref === 'object' && Array.isArray((ref as { external_xy?: unknown }).external_xy)) {
    return 'point'
  }
  const resolved = resolveVertexRef(entityIds, ref)
  if (!resolved) return 'unresolved'
  if (resolved.point !== undefined) return 'point'
  const kind = kindById.get(resolved.entity)
  if (kind === 'line') return 'line'
  if (kind === 'point') return 'point'
  return 'curve'
}

/**
 * The reason a `colinear` pair cannot become a solver row, or null when it can.
 * A missing operand has no row at all (the solver's coincident guard returns
 * early), so it is refused like a bad shape rather than authored to vanish. An
 * `unresolved` operand passes here so the stale-ref path owns its reason.
 *
 * `sideOf` normalises one operand to its side: the lowering and the applier
 * hand in the document's stored refs, while the drive rule sees the step's
 * target spellings.
 */
export function colinearShapeProblem(
  a: unknown,
  b: unknown,
  sideOf: (operand: unknown) => ConstraintOperandSide,
): string | null {
  if (a === undefined || a === null || b === undefined || b === null) return COLINEAR_SHAPE_REASON
  const sideA = sideOf(a)
  const sideB = sideOf(b)
  if (sideA === 'unresolved' || sideB === 'unresolved') return null
  if (sideA === 'curve' || sideB === 'curve') return COLINEAR_SHAPE_REASON
  if (sideA === 'point' && sideB === 'point') return COLINEAR_SHAPE_REASON
  return null
}
