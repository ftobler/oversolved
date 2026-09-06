/**
 * Per-primitive picking identity.
 *
 * The ID buffer needs a unique integer per *rendered* b-rep primitive so the
 * cursor can resolve exactly which one it is over. That uniqueness must not
 * depend on the primitive's query string, which is a semantic identity that can
 * legitimately repeat (two edges sharing an ancestral query, or an edge with no
 * minted construction UUID). A body hands the renderer a concrete, ordered list
 * of primitives, so its index within that body is a stable, always-unique key.
 *
 * `bodyKey` is the same `${featureId}/${bodyId}` the ID layers register under,
 * so the key computed here (registry side) matches the one Body3D recomputes to
 * isolate the single hovered primitive.
 *
 * `layer` is load-bearing: the store's `hoveredPickKey` / `selectedPicks` hold
 * the bare pick-key string with no layer alongside it, so without the layer in the
 * key a face, edge and vertex at the same body index (all `bodyKey#i`) would
 * collide there and cross-highlight. Qualifying by layer keeps the id -> element
 * back-mapping unique across every pickable layer, not just within one.
 */
export function bodyKeyFor(featureId: string, bodyId: string): string {
  return `${featureId}/${bodyId}`
}

export function primitivePickKey(bodyKey: string, primitiveIndex: number, layer: string): string {
  return `${bodyKey}#${layer}#${primitiveIndex}`
}

// Structural "is this string a per-primitive pickKey" test, tolerant of a body
// key that itself contains '#' (matched from the RIGHT): a pickKey ends
// `#<layer>#<index>` with a non-empty layer and a bare non-negative integer
// index, and has a non-empty bodyKey before it. parsePickKeyIndex uses the exact
// same shape when it has the concrete prefix in hand; this is for callers (state
// invariants) that only have the string.
const PICK_KEY_SHAPE = /^.+#[^#]+#\d+$/
export function isPickKeyString(claim: string): boolean {
  return PICK_KEY_SHAPE.test(claim)
}

/**
 * Which primitive indices of `(bodyKey, layer)` the live pick set claims.
 *
 * The direction matters for a heavy model: the pick set holds one key while
 * hovering and a handful while multi-selected, whereas a body holds thousands of
 * primitives. Parsing the index back out of each pick key costs O(picks); minting
 * a key per primitive to compare against the set would cost O(primitives) string
 * allocations per body, on every pointer move. Returns null when nothing in the
 * set belongs to this body/layer, so callers can skip the claim logic entirely.
 * `count`, when the caller knows it (the highlight path does: it is the body's
 * primitive count), bounds every parsed index to what this body/layer actually
 * has.
 */
export function pickedIndicesForBody(
  pickKeys: ReadonlySet<string>,
  bodyKey: string,
  layer: string,
  count = Number.MAX_SAFE_INTEGER,
): Set<number> | null {
  if (pickKeys.size === 0) return null
  const prefix = `${bodyKey}#${layer}#`
  let out: Set<number> | null = null
  for (const key of pickKeys) {
    const idx = parsePickKeyIndex(key, prefix, count)
    if (idx < 0) continue
    if (!out) out = new Set<number>()
    out.add(idx)
  }
  return out
}

/** Index encoded in `key` when it carries `prefix`, else -1. `count` bounds the
 *  index to the primitives the caller actually has; without one the default
 *  bounds it at the largest exactly-representable integer. */
export function parsePickKeyIndex(key: string, prefix: string, count = Number.MAX_SAFE_INTEGER): number {
  if (!key.startsWith(prefix)) return -1
  const tail = key.slice(prefix.length)
  // Reject anything that is not a bare non-negative integer: a body key
  // containing '#' could otherwise let a foreign key parse as an index.
  if (!/^\d+$/.test(tail)) return -1
  const idx = Number(tail)
  // Tails above 2^53 lose integer precision (two distinct tails collapse onto
  // one set entry) and absurdly long tails overflow to Infinity. Bound them
  // explicitly so an over-precision key cannot alias a real primitive index.
  if (idx > Number.MAX_SAFE_INTEGER) return -1
  return idx < count ? idx : -1
}
