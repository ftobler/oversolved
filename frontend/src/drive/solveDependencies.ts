// The mutations whose handler reads a sketch feature's `initial`, the geometry
// the solve write-back bakes. A deferred run reaches such a step before the
// previous solve wrote back, so the handler would read authored geometry while
// a one-step-per-call chain reads the solved one; the run flushes first, which
// is what keeps the same script chunk-stable. A mutation that only writes
// `initial` (add_rect, add_entity) does not need this: it has no previous
// solved state to read.

import { isFaceProjectionSource } from '@/kernel/features/projectionMembers'

type RawStep = { [key: string]: unknown }

function isRecord(value: unknown): value is RawStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A dock pick names the host constraint whose current contact is the seed, so
 *  any mutation carrying one reads `feature.initial` through `dockLocationOf`.
 *  The ref can ride a target list or any of the sugar's corner/snap fields, so
 *  scan the whole step rather than list today's field names. */
function carriesDockRef(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('dock:')
  if (Array.isArray(value)) return value.some(carriesDockRef)
  if (isRecord(value)) return Object.values(value).some(carriesDockRef)
  return false
}

// `vertex:<sketch>:<entity>:fit<k>` deletes one positional fit-spline point,
// which the handler decodes from and writes back to `initial`.
function deletesFitPoint(raw: RawStep): boolean {
  const targets = raw.targets
  return Array.isArray(targets)
    && targets.some(target => typeof target === 'string' && /^vertex:[^:]+:[^:]+:fit\d+$/.test(target))
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
    // The mirror, offset, fillet and pattern plans are built from the current params.
    case 'mirror_entities':
    case 'apply_offset':
    case 'fillet_corners':
    case 'pattern_entities':
      return true
    // Fit-spline editors decode the positional params they are editing.
    case 'insert_fit_point':
    case 'set_fit_spline_handle':
      return true
    case 'delete':
      return deletesFitPoint(raw)
    // A face projection's member ids come from the face's boundary in the last
    // solved bodies, so the step must run against a settled document. An edge,
    // vertex or sketch source takes its kind from the pick and needs no solve.
    case 'add_projected_entity':
      return typeof raw.source === 'string' && isFaceProjectionSource(raw.source)
    default:
      return carriesDockRef(raw)
  }
}
