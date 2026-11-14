/**
 * The precision a body inherited from the sketch solves that built it, and the
 * two tolerances the kernel's face merge (ShapeUpgrade_UnifySameDomain) may read
 * from it.
 *
 * The sketch solver targets OCC's own pair (`OCC_ANGULAR`, `OCC_CONFUSION`) and
 * reports what it actually reached (`angular_miss` / `linear_miss`). OCC's merge
 * reads those compiled-in defaults, so two faces the solver left a little apart
 * stay two faces: a visible seam. The rule is report-driven only: the merge
 * widens by the miss the solver MEASURED, up to a ceiling. A free direction no
 * row measures is not a reported miss, so it never widens anything; authoring a
 * row that measures it is the fix (user decision 2026-11-14).
 *
 * Two ceilings bound the widening, both existing rungs of the tolerance ladder:
 * `TOL_SURFACE_PARALLEL` (1e-9 rad, "same analytic axis") and
 * `TOL_SURFACE_IDENTITY` (1e-6, surface identity). Past them the merge still
 * runs, but at the ceiling, and the feature says so: merging further would fold
 * a crease the solver never vouched for.
 */

import type { Repository } from './query'
import {
  OCC_ANGULAR,
  OCC_CONFUSION,
  TOL_SURFACE_IDENTITY,
  TOL_SURFACE_PARALLEL,
} from './solverConstants'

/** The realised precision of the geometry a body was built from, in radians
 *  (angular) and document length units (linear). `sketch` names the solve that
 *  reported it, so a ceiling warning can say which one. */
export interface KernelPrecision {
  angular: number
  linear: number
  sketch?: string
}

/** The widest the merge may read, one rung above the contract on each side. */
export const MERGE_CEILING: Readonly<KernelPrecision> = {
  angular: TOL_SURFACE_PARALLEL,
  linear: TOL_SURFACE_IDENTITY,
}

/** `value` floored at `floor`; a non-finite value is no measurement, so it reads
 *  as the floor. The solver reports NaN when no row of that class was measured
 *  and INFINITY on a row-classification failure; neither may widen a merge. */
function floored(value: unknown, floor: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(floor, value) : floor
}

/** A solve's reported misses as a precision record, floored at the contract.
 *  The sketch id rides along for the ceiling warning. */
export function contractPrecision(
  angular: unknown,
  linear: unknown,
  sketch?: string,
): KernelPrecision {
  return {
    angular: floored(angular, OCC_ANGULAR),
    linear: floored(linear, OCC_CONFUSION),
    ...(sketch ? { sketch } : {}),
  }
}

/** The componentwise max of two records (either may be absent), keeping the
 *  sketch name of the record that dominates. "The max over its producing
 *  sketches' misses" is what a body made from several profiles carries. */
export function maxPrecision(
  a: KernelPrecision | null | undefined,
  b: KernelPrecision | null | undefined,
): KernelPrecision | null {
  if (!a) return b ?? null
  if (!b) return a
  const bDominates = b.angular > a.angular || (b.angular === a.angular && b.linear > a.linear)
  const winner = bDominates ? b : a
  return {
    angular: Math.max(a.angular, b.angular),
    linear: Math.max(a.linear, b.linear),
    ...(winner.sketch ? { sketch: winner.sketch } : {}),
  }
}

/** Which inherited axes sit above the merge ceiling. */
export interface CeilingMiss {
  angular: boolean
  linear: boolean
}

/** The tolerances one clean reads for this inherited precision, clamped to the
 *  ceiling, plus the axes that had to be clamped (null when none were). */
export interface MergeTolerance {
  angularTol: number
  linearTol: number
  ceilingMiss: CeilingMiss | null
}

export function mergeTolerance(precision?: KernelPrecision | null): MergeTolerance {
  const angular = floored(precision?.angular, OCC_ANGULAR)
  const linear = floored(precision?.linear, OCC_CONFUSION)
  const angularHit = angular > MERGE_CEILING.angular
  const linearHit = linear > MERGE_CEILING.linear
  return {
    angularTol: Math.min(angular, MERGE_CEILING.angular),
    linearTol: Math.min(linear, MERGE_CEILING.linear),
    ceilingMiss: angularHit || linearHit ? { angular: angularHit, linear: linearHit } : null,
  }
}

const tol = (value: number): string => value.toExponential()

/**
 * The build warning a feature carries when its merge ran at the ceiling. Null
 * when nothing was clamped, which is every within-contract solve. The sketch is
 * named when the record knows it; a body whose warning was already emitted at
 * the merge that acquired the precision carries the same name forward.
 */
export function precisionCeilingWarning(precision: KernelPrecision): string | null {
  const { ceilingMiss } = mergeTolerance(precision)
  if (ceilingMiss === null) return null
  const who = precision.sketch
    ? `sketch ${precision.sketch} solved to`
    : 'the merged geometry carries'
  const parts: string[] = []
  if (ceilingMiss.angular) {
    parts.push(
      `${who} ${tol(precision.angular)} rad, above the kernel's ${tol(MERGE_CEILING.angular)} ` +
      'merge ceiling; near-coplanar faces may stay split',
    )
  }
  if (ceilingMiss.linear) {
    parts.push(
      `${who} ${tol(precision.linear)}, above the kernel's ${tol(MERGE_CEILING.linear)} ` +
      'merge ceiling; near-coincident faces may stay split',
    )
  }
  return parts.join('; ')
}

/** The repo key a solved sketch publishes its realised precision under, beside
 *  `_topo_<id>` (`features/postRegister.ts`). */
export function precisionKey(sketchId: string): string {
  return '_precision_' + sketchId
}

/** The precision a solve result reports for `sketchId`, or null when the result
 *  carries neither miss (a non-sketch feature, a failed solve). */
export function precisionOfSolve(
  result: { angular_miss?: unknown; linear_miss?: unknown },
  sketchId: string,
): KernelPrecision | null {
  if (!('angular_miss' in result) && !('linear_miss' in result)) return null
  return contractPrecision(result.angular_miss, result.linear_miss, sketchId)
}

function isPrecisionRecord(value: unknown): value is KernelPrecision {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<KernelPrecision> & { sketch?: unknown }
  return typeof v.angular === 'number' && Number.isFinite(v.angular)
    && typeof v.linear === 'number' && Number.isFinite(v.linear)
    && (v.sketch === undefined || typeof v.sketch === 'string')
}

/**
 * The realised precision published for `sketchId`, or null when this solve
 * registered none (a document restored from before the field existed, or a
 * feature that is not a sketch). A null reads as the contract, never as "widen
 * to the ceiling".
 */
export function sketchPrecision(globalRepo: Repository, sketchId: string): KernelPrecision | null {
  if (!sketchId) return null
  const raw = globalRepo.elements.get(precisionKey(sketchId))
  return isPrecisionRecord(raw) ? { ...raw } : null
}
