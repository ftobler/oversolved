// The names-for-people tripwire, shared by the warning suites: a user-facing
// sentence may not print a raw document id. A token is id-looking at 16+
// characters, except the kernel's own long prose words and the command/mutation
// vocabulary a hint legitimately names (`reorder_features`, an add command).

import { COMMAND_NAMES } from '@/utils/core/commandNames'
import { MUTATION_CATALOG } from '@/drive/mutationCatalog'

const PROSE_WORDS = new Set(['underconstrained'])
const VOCABULARY = new Set(
  [...COMMAND_NAMES, ...Object.keys(MUTATION_CATALOG)].map(word => word.toLowerCase()),
)

/** The id-looking tokens in a sentence, minus the vocabulary above. */
export function leakedIds(text: string): string[] {
  return (text.match(/[A-Za-z0-9_-]{16,}/g) ?? [])
    .filter(token => {
      const lower = token.toLowerCase()
      return !PROSE_WORDS.has(lower) && !VOCABULARY.has(lower)
    })
}
