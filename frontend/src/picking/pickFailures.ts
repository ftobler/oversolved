// The pick queries the last solve refused.
//
// A modifier reports two kinds of non-applied pick (kernel partial result):
// `unresolved_*` matched no current primitive (stale, re-pick it) and
// `failed_*` resolved but the modifier refused or skipped it (the parameter or
// the geometry is the fix). Only the second kind has geometry on screen to
// paint, so the relation hint reads this one to give those picks the failure
// colour the chip already uses.
//
// Defensive on purpose: `solveResults` is the store's heterogeneous bag of
// kernel payloads, and a feature result may be a string, null or a value from
// a kind that has no picks at all.

const PICK_KEYS = ['failed_edges', 'failed_faces'] as const

/** Every query the last solve refused as a pick, across the whole document. */
export function failedPickQueries(
  solveResults: { readonly [featureId: string]: unknown } | undefined,
): ReadonlySet<string> {
  const out = new Set<string>()
  if (!solveResults) return out
  for (const result of Object.values(solveResults)) {
    if (typeof result !== 'object' || result === null) continue
    for (const key of PICK_KEYS) {
      const raw = (result as { [key: string]: unknown })[key]
      if (!Array.isArray(raw)) continue
      for (const value of raw) if (typeof value === 'string' && value) out.add(value)
    }
  }
  return out
}
