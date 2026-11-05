// The mutations whose handler reads a sketch feature's `initial`, the geometry
// the solve write-back bakes. A deferred run reaches such a step before the
// previous solve wrote back, so the handler would read authored geometry while
// a one-step-per-call chain reads the solved one; the run flushes first, which
// is what keeps the same script chunk-stable. A mutation that only writes
// `initial` (add_rect, add_entity) does not need this: it has no previous
// solved state to read.

type RawStep = { [key: string]: unknown }

function isRecord(value: unknown): value is RawStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a step's applier reads `feature.initial` and would answer differently
 *  on an authored document than on the settled one the previous step left. */
export function usesSettledSketchGeometry(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  switch (raw.type) {
    // Relative moves and resizes are applied to the current params.
    case 'move_entity':
    case 'move_vertex':
    case 'move_vertex_with_constraint':
    case 'resize_circle':
      return true
    // The mirror and offset plans are built from the current params.
    case 'mirror_entities':
    case 'apply_offset':
      return true
    // Fit-spline editors decode the positional params they are editing.
    case 'insert_fit_point':
    case 'set_fit_spline_handle':
      return true
    // A dock handle materializes its seed from the host constraint's current
    // location; an ordinary target does not read geometry.
    case 'add_constraint':
      return Array.isArray(raw.targets)
        && raw.targets.some(target => typeof target === 'string' && target.startsWith('dock:'))
    default:
      return false
  }
}
