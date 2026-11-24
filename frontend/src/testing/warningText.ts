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

/** The id-looking tokens in a sentence, minus the vocabulary above and the
 *  document's own labels. A label is user text (a feature may be called
 *  `Rectangular plate 2026`), so a token inside one is not a leaked id. */
export function leakedIds(text: string, allowedLabels: readonly string[] = []): string[] {
  const labels = allowedLabels.map(label => label.trim()).filter(label => label !== '')
  return (text.match(/[A-Za-z0-9_-]{16,}/g) ?? [])
    .filter(token => {
      const lower = token.toLowerCase()
      if (PROSE_WORDS.has(lower) || VOCABULARY.has(lower)) return false
      return !labels.some(label => label.includes(token))
    })
}
