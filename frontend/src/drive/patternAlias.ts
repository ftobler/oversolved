// The one-release aliases. The appliers already translate the legacy payloads
// (the retired `add_pattern` through the loader's split, utils/core/patternSplit.ts;
// the instance pattern's `sketch` into its leading target), so the document a
// step lands is the row a migrated file loads as. This module is only the
// drive's side of the aliases: the note a step reply carries, kept in one place
// so the browser bridge and the headless runner word it the same.
import type { Mutation } from '@/types/cad'

export const PATTERN_ALIAS_DEPRECATION =
  'add_pattern is deprecated and will be removed in the next release; it was translated to ' +
  'linear_pattern/circular_pattern. Use add_linear_pattern or add_circular_pattern.'

export const INSTANCE_SKETCH_ALIAS_NOTE =
  'the instance pattern takes one `targets` list now: the retired `sketch` field was rewritten into its ' +
  'leading target. Send `targets: ["@sk1"]` instead.'

/** The deprecation note an `add_pattern` step earns, or null for every other
 *  mutation. */
export function patternAliasNote(mutation: Mutation): string | null {
  return mutation.type === 'add_pattern' ? PATTERN_ALIAS_DEPRECATION : null
}

/** The note an instance pattern step earns when it named the retired `sketch`
 *  field, or null for every other instance pattern write. */
export function instanceSketchAliasNote(mutation: Mutation): string | null {
  if (mutation.type === 'add_instance_pattern') {
    return typeof mutation.sketch === 'string' && mutation.sketch !== '' ? INSTANCE_SKETCH_ALIAS_NOTE : null
  }
  if (mutation.type === 'set_instance_pattern_field' && mutation.field === 'sketch') {
    return INSTANCE_SKETCH_ALIAS_NOTE
  }
  return null
}
