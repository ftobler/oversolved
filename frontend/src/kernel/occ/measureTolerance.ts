/**
 * The measure tolerance comparator, shared by the analytic-volume seed
 * (`occ/__tests__/volumeOracleReal.test.ts`) and the reference oracle corpus
 * (`src/oracle/`). It lives in a leaf module because both suites must apply the
 * identical budget; two copies would let the corpus and the seed drift apart.
 *
 * The budget is proportional to the expected value's own size, exactly as a
 * mesh tolerance would be: rel * expected covers the integrator's convergence,
 * and an absolute floor covers a measure near zero.
 */

export interface MeasureTolerance {
  rel: number
  abs: number
}

export const DEFAULT_MEASURE_TOLERANCE: MeasureTolerance = { rel: 1e-6, abs: 1e-6 }

/** True when `actual` is within the tolerance budget of `expected`. */
export function valueWithinTolerance(
  actual: number,
  expected: number,
  tolerance: MeasureTolerance = DEFAULT_MEASURE_TOLERANCE,
): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
  return Math.abs(actual - expected) <= tolerance.rel * Math.abs(expected) + tolerance.abs
}

/** True when every component of `actual` is within tolerance of `expected`. */
export function vectorWithinTolerance(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: MeasureTolerance = DEFAULT_MEASURE_TOLERANCE,
): boolean {
  if (actual.length !== expected.length) return false
  return actual.every((a, i) => valueWithinTolerance(a, expected[i], tolerance))
}
