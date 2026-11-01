// The one mapping from a solve status to the colour sketch geometry is drawn
// in. Two copies used to live inside Geometry3D and disagree about a status the
// map did not know: the per-entity one fell back to the inactive grey, the
// sketch-wide one to the solved blue. There is now one answer.
import {
  COLOR_ERROR, COLOR_FULLY_CONSTRAINED, COLOR_INACTIVE, COLOR_SOLVED,
} from '@/utils/core/partColors'
import type { ConstraintStatus } from '@/types/cad'

/**
 * The sketch's overall colour: fully constrained white, underconstrained blue,
 * an error red, and the inactive grey for everything else -- a sketch outside
 * its editor, one with no solve yet, and any status the colour map does not
 * know. An unknown status is not a claim that the sketch solved cleanly, so it
 * must not borrow the solved hue.
 */
export function sketchStatusColor(solveStatus: string | undefined, isEditing: boolean): string {
  if (!isEditing) return COLOR_INACTIVE
  switch (solveStatus) {
    case 'fully_constrained': return COLOR_FULLY_CONSTRAINED
    case 'underconstrained': return COLOR_SOLVED
    case 'overconstrained':
    case 'exception': return COLOR_ERROR
    default: return COLOR_INACTIVE
  }
}

/**
 * The colour of one entity: its own status when the solve reported one, else
 * the sketch's overall answer. An entity only carries a status while the sketch
 * is the active edit target.
 */
export function entityStatusColor(
  entityStatus: ConstraintStatus | undefined,
  solveStatus: string | undefined,
  isEditing: boolean,
): string {
  if (!isEditing) return COLOR_INACTIVE
  switch (entityStatus) {
    case 'fully_constrained': return COLOR_FULLY_CONSTRAINED
    case 'underconstrained': return COLOR_SOLVED
    case 'overconstrained': return COLOR_ERROR
    default: return sketchStatusColor(solveStatus, isEditing)
  }
}
