// The part editor's measurement entry point. The rules, adapters and formatter
// live in utils/measure; this keeps the page-facing signature stable while the
// work happens in the pure core.
import type { Sketch, PartResult, LengthUnit } from '@/types/cad'
import { measureSelectionPicks, type MeasureContext, type SelectionMeasurement } from '@/utils/measure/measureSelection'

/**
 * Compute the best measurement for a set of selected picks, plus the kernel
 * question when the pair table asks OCCT for the answer.
 *
 * Every pick is resolved to a world primitive first (a body edge/face/vertex, a
 * sketch entity/vertex, a datum plane or a whole body), then the selection size
 * decides: one pick reads its own measurement, two read the pair's, anything
 * else reads nothing.
 *
 * @param selection - selection ids (`entity:<fid>:<eid>`, `vertex:...`,
 *   `@<body>/<kind>/<n>`, a `?` ancestry query or `@<featureId>`)
 * @param sketch - the flat sketch a sketch-edit caller narrowed to its feature;
 *   solveResults carries the per-feature sketch and frame and wins when present
 * @param solveResults - the solve's result map, keyed by feature id
 * @param parts - the solve's bodies, keyed by body id
 * @param unit - the document's length unit; the numbers are already in it
 * @returns the sync HUD lines (0 to 3) and the kernel ask, if any
 */
export function computeMeasurement(
  selection: ReadonlySet<string>,
  sketch: Sketch,
  solveResults?: MeasureContext['solveResults'],
  parts?: Record<string, PartResult>,
  unit: LengthUnit = 'mm',
): SelectionMeasurement {
  return measureSelectionPicks(selection, { sketch, solveResults, parts, unit })
}

/** The sync lines only, the shape the HUD used before the kernel cell existed. */
export function computeMeasurements(
  selection: ReadonlySet<string>,
  sketch: Sketch,
  solveResults?: MeasureContext['solveResults'],
  parts?: Record<string, PartResult>,
  unit: LengthUnit = 'mm',
): string[] {
  return computeMeasurement(selection, sketch, solveResults, parts, unit).lines
}
