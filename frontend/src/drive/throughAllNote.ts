// A through_all cut never reads a distance, so an add that was handed one drops
// it before it reaches the document. The drive's note channel is how a script
// learns that: the geometry is what was asked for and the step is not a problem,
// but the author still needs to know the number was not stored. Shared by the
// browser bridge and the headless runner so both word it the same.
import type { Mutation, PartDoc } from '@/types/cad'

export const THROUGH_ALL_DISTANCE_NOTE =
  'extrude: through_all takes no distance; the distance was dropped'

/** The note for a step that dropped a through_all distance, or null otherwise.
 *  A setter write needs the live document to know the feature's termination;
 *  an add carries its own inline fields. */
export function throughAllDistanceNote(mutation: Mutation, doc: PartDoc | null): string | null {
  if (mutation.type === 'add_extrude') {
    return mutation.termination === 'through_all' && mutation.distance !== undefined
      ? THROUGH_ALL_DISTANCE_NOTE
      : null
  }
  if (mutation.type === 'set_extrude_field' && (mutation.field === 'distance' || mutation.field === 'depth')) {
    if (mutation.value === undefined || mutation.value === null || mutation.value === '') return null
    const feature = doc?.features?.find(entry => entry.id === mutation.featureId)
    if (feature?.kind === 'extrude' && feature.extrude?.termination === 'through_all') {
      return THROUGH_ALL_DISTANCE_NOTE
    }
  }
  return null
}
