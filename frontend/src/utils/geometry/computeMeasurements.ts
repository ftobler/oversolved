// The part editor's measurement entry point. The rules, adapters and formatter
// live in utils/measure; this keeps the page-facing signature stable while the
// work happens in the pure core.
import type { Sketch, BodyResult, LengthUnit } from '@/types/cad'
import { measureSelection } from '@/utils/measure/measureSelection'

/**
 * Compute the best measurement for a set of selected picks.
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
 * @param bodies - the solve's bodies, keyed by body id
 * @param unit - the document's length unit; the numbers are already in it
 * @returns the HUD lines, 0 to 3 (a pair can carry a second readout)
 */
export function computeMeasurements(
  selection: Set<string>,
  sketch: Sketch,
  solveResults?: Record<string, unknown>,
  bodies?: Record<string, BodyResult>,
  unit: LengthUnit = 'mm',
): string[] {
  return measureSelection(selection, { sketch, solveResults, bodies, unit })
}
