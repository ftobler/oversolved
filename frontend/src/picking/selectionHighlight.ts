import { primitivePickKey } from './pickKey'

/**
 * An active highlight request, expressed as two identity sets. This is the ONE
 * shape every highlight decision flows through, whether it is a durable click
 * selection or a transient hover:
 *
 * - `pickKeys`: the precise per-primitive pick keys (`bodyKey#layer#index`) that
 *   are live right now. A click stores the clicked primitive's key here; a hover
 *   carries a single key (the one under the cursor).
 * - `queries`: the durable ancestral queries. A click persists them; a hover
 *   carries the single query of the hovered primitive.
 *
 * Click uses `{ selectedPickKeys, normalSelection }`; hover uses a size <= 1 pair
 * `{ {hoveredPickKey}, {hoveredSelectionId} }`. Because both go through the same
 * function below, hover and click are guaranteed symmetric: identical active
 * inputs always yield identical highlight flags.
 */
export interface ActiveHighlight {
  pickKeys: ReadonlySet<string>
  queries: ReadonlySet<string>
}

/**
 * Decide which b-rep primitives in one body render as highlighted.
 *
 * Selection identity is deliberately split in two:
 *
 * - The **durable** identity is the ancestral query. It is what a feature
 *   persists, what re-highlights a pick after a re-solve, and what every
 *   non-viewport consumer (measurement, projection, parts list, the feature
 *   editors) reads out of `normalSelection`. That set stays query-keyed.
 * - The **live** identity is the per-primitive pickKey (`bodyKey#layer#index`)
 *   the click or hover captured. Two primitives can legitimately share a query
 *   (no minted UUID, shared octant), so the query alone cannot isolate the one
 *   the user is pointing at; the pickKey can.
 *
 * A primitive highlights iff its query is in the active query set AND either it
 * is the precise pick, or no precise pick has claimed that query:
 *
 *   active.queries.has(q) && (active.pickKeys.has(pk) || !claimed.has(q))
 *
 * - Live pick: the pointed primitive's pickKey is active, so it wins the first
 *   arm; a sibling sharing its query loses the second arm (the query is claimed)
 *   and does not co-highlight. This is the decoupling: the highlight isolates
 *   ONE primitive regardless of query quality.
 * - Persisted / re-highlighted pick: after a re-solve the transient pickKey is
 *   gone, so `pickKeys` holds nothing for it. The query survives in `queries`,
 *   nothing claims it, and it highlights by query membership. If that query is
 *   non-unique the fallback groups every sibling sharing it -- but that is a
 *   query-coverage concern (naming-by-construction work), not a selection one,
 *   and it is EXPECTED until queries are unique per primitive.
 * - The `active.queries.has(q)` gate is load-bearing: a pickKey left in the set
 *   whose query has since left `queries` (e.g. a same-query re-click toggled the
 *   query off) is gated out, so a stale pickKey can never highlight something the
 *   durable selection no longer contains.
 */
export function computeHighlight(
  bodyKey: string,
  layer: string,
  queries: ReadonlyArray<string>,
  active: ActiveHighlight,
): boolean[] {
  // Queries in THIS body already claimed by a precise pickKey pick. Only worth
  // computing when a live pick exists; the persisted path leaves it empty. The
  // pick key is layer-qualified so a pick in another layer (a vertex, say) at the
  // same body index cannot claim this layer's primitive.
  const claimed = new Set<string>()
  if (active.pickKeys.size > 0) {
    for (let i = 0; i < queries.length; i++) {
      if (active.pickKeys.has(primitivePickKey(bodyKey, i, layer))) claimed.add(queries[i])
    }
  }
  const out = new Array<boolean>(queries.length)
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if (!active.queries.has(q)) { out[i] = false; continue }
    out[i] = active.pickKeys.has(primitivePickKey(bodyKey, i, layer)) || !claimed.has(q)
  }
  return out
}
