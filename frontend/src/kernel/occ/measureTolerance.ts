/**
 * The measure tolerance comparator and the row-producing comparison shared by
 * the analytic-volume seed (`occ/__tests__/volumeOracleReal.test.ts`), the
 * reference oracle corpus (`src/oracle/`), the translation corpus
 * (`src/translations/`) and the regression corpus (`src/regressions/`). It
 * lives in a leaf module because every suite must apply the identical budget;
 * two copies would let them drift apart.
 *
 * The budget is proportional to the expected value's own size, exactly as a
 * mesh tolerance would be: rel * expected covers the integrator's convergence,
 * and an absolute floor covers a measure near zero.
 */

import type { MeasureRecord } from './measure'

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

export type MeasureName = 'bodies' | 'volume' | 'area' | 'centroid' | 'bbox' | 'faces' | 'edges'

/** How structural counts are judged: reported always, enforced only in strict. */
export type TopologyMode = 'report' | 'strict'

export interface MeasureRow {
  measure: MeasureName
  ours: number | number[] | null
  theirs: number | number[]
  // ours - theirs, per component, or null when ours has no value to subtract.
  delta: number | number[] | null
  within: boolean
  // false: reported, not failed (topology in report mode).
  enforced: boolean
  // On a failing centroid or bbox row whose shape measures all passed, the
  // likely cause is the reference's frame rather than its geometry; set only
  // when the Z-up to Y-up swap actually lines the row up.
  hint?: string
}

export interface CompareOptions {
  tolerance?: MeasureTolerance
  // The oracle runs strict because its counts are the persistent-naming
  // assertion; a translation defaults to the mode its reference states.
  topology?: TopologyMode
}

/**
 * What a caller states about an expected body set. The oracle and translation
 * references are the full record (`OracleMeasures` assigns to this), while a
 * regression case may omit a measure it does not freeze or state `centroid` /
 * `bbox` as null for a document with no body: an omitted or null field produces
 * no row, so nothing is checked that the case did not state.
 */
export interface MeasureExpectation {
  bodies: number
  volume?: number
  area?: number
  centroid?: readonly number[] | null
  bbox?: readonly number[] | null
  faces?: number
  edges?: number
}

function scalarRow(
  measure: MeasureName,
  ours: number,
  theirs: number,
  tolerance: MeasureTolerance,
  enforced = true,
): MeasureRow {
  return {
    measure,
    ours,
    theirs,
    delta: ours - theirs,
    within: valueWithinTolerance(ours, theirs, tolerance),
    enforced,
  }
}

function exactRow(measure: MeasureName, ours: number, theirs: number, enforced = true): MeasureRow {
  return { measure, ours, theirs, delta: ours - theirs, within: ours === theirs, enforced }
}

function vectorRow(
  measure: MeasureName,
  ours: number[] | null,
  theirs: number[],
  tolerance: MeasureTolerance,
): MeasureRow {
  if (ours === null) {
    return { measure, ours: null, theirs, delta: null, within: false, enforced: true }
  }
  const delta = ours.map((value, i) => value - theirs[i])
  return {
    measure,
    ours,
    theirs,
    delta,
    within: vectorWithinTolerance(ours, theirs, tolerance),
    enforced: true,
  }
}

/**
 * A Z-up reference's point, swapped into Oversolved's Y-up frame: a CadQuery
 * point (x, y, z) is our (x, z, -y). Applying the map to the reference is the
 * same check as applying its inverse to our value, and reads as "the reference
 * was stated in the other frame".
 */
function zUpPointToYUp(point: readonly number[]): number[] {
  return [point[0], point[2], -point[1]]
}

/** The same swap for a bbox: x stays, the Y range becomes [-ymax,-ymin] and
 *  the Z range becomes the Z-up y range. */
function zUpBboxToYUp(bbox: readonly number[]): number[] {
  return [bbox[0], bbox[2], -bbox[4], bbox[3], bbox[5], -bbox[1]]
}

/** True when a failing positional value is exactly what the frame swap predicts. */
function swapsIntoPlace(
  ours: readonly number[] | null,
  theirs: readonly number[],
  swapped: (reference: readonly number[]) => number[],
  tolerance: MeasureTolerance,
): boolean {
  return ours !== null && vectorWithinTolerance(ours, swapped(theirs), tolerance)
}

/**
 * Compare a measured record against a stated expectation, one row per measure.
 * A row the expectation omits (faces, edges) is omitted rather than passed, and
 * a missing centroid or bbox is a failing row, not a throw: the report is data
 * an agent loop reads.
 */
export function compareMeasures(
  ours: MeasureRecord,
  theirs: MeasureExpectation,
  opts: CompareOptions = {},
): { pass: boolean; rows: MeasureRow[] } {
  const tolerance = opts.tolerance ?? DEFAULT_MEASURE_TOLERANCE
  const topology = opts.topology ?? 'strict'
  const rows: MeasureRow[] = [exactRow('bodies', ours.bodies, theirs.bodies)]
  if (theirs.volume !== undefined) rows.push(scalarRow('volume', ours.volume, theirs.volume, tolerance))
  if (theirs.area !== undefined) rows.push(scalarRow('area', ours.area, theirs.area, tolerance))
  if (theirs.centroid != null) {
    rows.push(vectorRow('centroid', ours.centroid, [...theirs.centroid], tolerance))
  }
  if (theirs.bbox != null) {
    rows.push(vectorRow('bbox', ours.bbox, [...theirs.bbox], tolerance))
  }
  if (theirs.faces !== undefined) {
    rows.push(exactRow('faces', ours.faces, theirs.faces, topology === 'strict'))
  }
  if (theirs.edges !== undefined) {
    rows.push(exactRow('edges', ours.edges, theirs.edges, topology === 'strict'))
  }
  // A rotation leaves volume and area alone but moves centroid and bbox. When
  // exactly the positional rows fail, name the likely cause only if the frame
  // swap really explains the numbers: a centroid merely off by a little is a
  // geometry or placement error, and the row's own delta already says by how
  // much. A bbox that happens to align under the swap while the centroid does
  // not is still worth the hint, so each row is judged on its own value.
  const shapeRows = rows.filter((row) => row.measure === 'bodies' || row.measure === 'volume' || row.measure === 'area')
  const shapeAgrees = shapeRows.some((row) => row.measure === 'volume' || row.measure === 'area')
    && shapeRows.every((row) => row.within)
  if (shapeAgrees) {
    for (const row of rows) {
      if (row.within || row.ours === null || !Array.isArray(row.ours)) continue
      const swapped = row.measure === 'centroid'
        ? swapsIntoPlace(row.ours, theirs.centroid ?? [], zUpPointToYUp, tolerance)
        : row.measure === 'bbox'
          ? swapsIntoPlace(row.ours, theirs.bbox ?? [], zUpBboxToYUp, tolerance)
          : false
      if (swapped) {
        row.hint = 'volume and area agree and the frame swap lines this row up: Oversolved is Y-up; '
          + 'a CadQuery XY extrusion +Z maps to Front, and a centred box needs a symmetric or re-origined extrusion.'
      }
    }
  }
  return { pass: rows.every((row) => !row.enforced || row.within), rows }
}
