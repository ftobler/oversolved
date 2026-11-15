// The one-release `add_pattern` alias. The applier already translates the
// legacy payload through the loader's split (utils/core/patternSplit.ts), so the
// document it lands is the row a migrated file loads as. This module is only the
// drive's side of the alias: the deprecation note a step reply carries, kept in
// one place so the browser bridge and the headless runner word it the same.
import type { Mutation } from '@/types/cad'

export const PATTERN_ALIAS_DEPRECATION =
  'add_pattern is deprecated and will be removed in the next release; it was translated to ' +
  'linear_pattern/circular_pattern. Use add_linear_pattern or add_circular_pattern.'

/** The deprecation note an `add_pattern` step earns, or null for every other
 *  mutation. */
export function patternAliasNote(mutation: Mutation): string | null {
  return mutation.type === 'add_pattern' ? PATTERN_ALIAS_DEPRECATION : null
}
