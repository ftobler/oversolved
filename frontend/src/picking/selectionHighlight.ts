import { primitivePickKey } from './pickKey'

/**
 * Decide which b-rep primitives in one body render as selected.
 *
 * Selection identity is deliberately split in two:
 *
 * - The **durable** identity is the ancestral query. It is what a feature
 *   persists, what re-highlights a pick after a re-solve, and what every
 *   non-viewport consumer (measurement, projection, parts list, the feature
 *   editors) reads out of `normalSelection`. That set stays query-keyed.
 * - The **live** identity is the per-primitive pickKey (`bodyKey#index`) the
 *   click captured. Two primitives can legitimately share a query (no minted
 *   UUID, shared octant), so the query alone cannot isolate the one the user
 *   clicked; the pickKey can.
 *
 * A primitive highlights iff its query is in the normal selection AND either it
 * is the precise pick, or no precise pick has claimed that query:
 *
 *   normalSelection.has(q) && (selectedPickKeys.has(pk) || !claimed.has(q))
 *
 * - Live pick: the clicked primitive's pickKey is selected, so it wins the
 *   first arm; a sibling sharing its query loses the second arm (the query is
 *   claimed) and does not co-highlight. This is the decoupling: the highlight
 *   isolates ONE primitive regardless of query quality.
 * - Persisted / re-highlighted pick: after a re-solve the transient pickKey is
 *   gone, so `selectedPickKeys` holds nothing for it. The query survives in
 *   `normalSelection`, nothing claims it, and it highlights by query membership.
 *   If that query is non-unique the fallback groups -- but that is a query
 *   coverage concern (unique-query work), not a selection one.
 * - The `normalSelection.has(q)` gate is load-bearing: a pickKey left in
 *   `selectedPickKeys` whose query has since left `normalSelection` (e.g. a
 *   same-query re-click toggled the query off) is gated out, so a stale pickKey
 *   can never highlight something the durable selection no longer contains.
 */
export function computePrimitiveSelection(
  bodyKey: string,
  queries: ReadonlyArray<string>,
  normalSelection: ReadonlySet<string>,
  selectedPickKeys: ReadonlySet<string>,
  layer: string,
): boolean[] {
  // Queries in THIS body already claimed by a precise pickKey pick. Only worth
  // computing when a live pick exists; the persisted path leaves it empty. The
  // pick key is layer-qualified so a pick in another layer (a vertex, say) at the
  // same body index cannot claim this layer's primitive.
  const claimed = new Set<string>()
  if (selectedPickKeys.size > 0) {
    for (let i = 0; i < queries.length; i++) {
      if (selectedPickKeys.has(primitivePickKey(bodyKey, i, layer))) claimed.add(queries[i])
    }
  }
  const out = new Array<boolean>(queries.length)
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if (!normalSelection.has(q)) { out[i] = false; continue }
    out[i] = selectedPickKeys.has(primitivePickKey(bodyKey, i, layer)) || !claimed.has(q)
  }
  return out
}
