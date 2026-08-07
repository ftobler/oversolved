import { pickedIndicesForBody } from './pickKey'

/**
 * An active highlight request. This is the ONE shape every highlight decision
 * flows through, whether it is a durable click selection or a transient hover:
 *
 * - `pickKeys`: the precise per-primitive pick keys (`bodyKey#layer#index`) that
 *   are live right now, grouped by the query each key claims. A click records
 *   the clicked primitive's key under its query here (the store's selectedPicks
 *   shape, preserved rather than flattened so computeHighlight can validate a
 *   claim against the primitive that currently owns its index); a hover carries
 *   a single (query, key) pair (the one under the cursor).
 * - `queries`: the durable ancestral queries. A click persists them; a hover
 *   carries the single query of the hovered primitive.
 *
 * Click uses `{ selectedPicks, normalSelection }`; hover uses a size <= 1 pair
 * `{ {hoveredPickKey}, {hoveredSelectionId} }`. Because both go through the same
 * function below, hover and click are guaranteed symmetric: identical active
 * inputs always yield identical highlight flags.
 */
export interface ActiveHighlight {
  pickKeys: ReadonlyMap<string, ReadonlySet<string>>
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
 *   the click or hover captured, grouped under the query it claims. Two
 *   primitives can legitimately share a query (no minted UUID, shared octant),
 *   so the query alone cannot isolate the one the user is pointing at; the
 *   pickKey can.
 *
 * A primitive highlights iff its query is in the active query set AND either it
 * is a live precise pick, or no live precise pick claims that query.
 *
 * - Live pick: the pointed primitive's pickKey is active and its index still
 *   resolves to a primitive carrying the claimed query, so it wins; a sibling
 *   sharing its query loses (the query is claimed) and does not co-highlight.
 *   This is the decoupling: the highlight isolates ONE primitive regardless of
 *   query quality.
 * - Persisted / re-highlighted pick: after a re-solve the transient pickKeys are
 *   gone (cleared at the solve seam), so `pickKeys` holds nothing for it. The
 *   query survives in `queries`, nothing claims it, and it highlights by query
 *   membership. If that query is non-unique the fallback groups every sibling
 *   sharing it -- but that is a query-coverage concern (naming-by-construction
 *   work), not a selection one, and it is EXPECTED until queries are unique per
 *   primitive.
 * - Stale claim belt-and-braces: a claim is honored only while its index still
 *   owns the query it was recorded under. A re-solve can shift indices, so a
 *   claim whose index now carries a different query (queries[i] !== claimQuery)
 *   is skipped entirely: it neither isolates that primitive nor suppresses a
 *   sibling. The solve seam normally clears every claim, but a missed solve path
 *   must degrade to inert, not to a wrong highlight.
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
  const out = new Array<boolean>(queries.length)
  if (active.queries.size === 0) { out.fill(false); return out }

  // Live precise-pick claims, walked per claimed query. The association is what
  // makes the belt-and-braces check possible: only a claim whose parsed index
  // still resolves to a primitive carrying the claimed query is live. Indices
  // are parsed out of the pick set rather than by minting a key per primitive
  // (see pickedIndicesForBody); the count threading keeps every parsed index in
  // range.
  const isolated = new Set<number>()
  const claimed = new Set<string>()
  for (const [claimQuery, keys] of active.pickKeys) {
    const picked = pickedIndicesForBody(keys, bodyKey, layer, queries.length)
    if (!picked) continue
    for (const i of picked) {
      if (queries[i] !== claimQuery) continue
      isolated.add(i)
      claimed.add(claimQuery)
    }
  }

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if (!active.queries.has(q)) { out[i] = false; continue }
    out[i] = isolated.has(i) || !claimed.has(q)
  }
  return out
}

/**
 * Per-(body, layer) highlight cache.
 *
 * `computeHighlight` is pure and O(primitives); a heavy model calls it for every
 * body on every pointer move, and the arrays it returns feed the memos that
 * rebuild vertex-colour buffers and re-upload them to the GPU. Both costs are
 * wasted on a body the pointer never touched, so this index adds the two things
 * a per-body cache can:
 *
 * - a query-set pre-check, so a body owning none of the active queries answers in
 *   O(smaller set) instead of scanning its primitives, and
 * - a shared all-false array for that answer, so the identity of the result does
 *   not change either. Downstream `useMemo`s keyed on the flags then skip
 *   entirely, which is what keeps hover cost independent of scene size.
 *
 * Build one per (bodyKey, layer, queries) and keep it for as long as the queries
 * array lives; it holds no state that a pick can invalidate.
 */
export class HighlightIndex {
  // The all-false answer, shared by reference so memos can skip on identity.
  readonly none: readonly boolean[]
  private readonly bodyKey: string
  private readonly layer: string
  private readonly queries: ReadonlyArray<string>
  private readonly querySet: ReadonlySet<string>

  constructor(bodyKey: string, layer: string, queries: ReadonlyArray<string>) {
    this.bodyKey = bodyKey
    this.layer = layer
    this.queries = queries
    this.querySet = new Set(queries)
    this.none = new Array<boolean>(queries.length).fill(false)
  }

  compute(active: ActiveHighlight): readonly boolean[] {
    if (!this.intersects(active.queries)) return this.none
    return computeHighlight(this.bodyKey, this.layer, this.queries, active)
  }

  // Whether any primitive is flagged. O(1) for the shared all-false answer.
  hasAny(flags: readonly boolean[] | null | undefined): boolean {
    if (!flags || flags === this.none) return false
    return flags.some(Boolean)
  }

  /** Does the active set name any query this body owns? Iterates the smaller of
   *  the two sets: a wide selection against a small body costs the body's size,
   *  and a single hovered query against a big body costs one lookup. */
  private intersects(queries: ReadonlySet<string>): boolean {
    if (queries.size === 0 || this.querySet.size === 0) return false
    const [small, large] = queries.size <= this.querySet.size
      ? [queries, this.querySet] : [this.querySet, queries]
    for (const q of small) if (large.has(q)) return true
    return false
  }
}
