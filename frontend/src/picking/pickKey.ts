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

/**
 * Resolve which primitive index in `layer` a stored pick key points at, or -1 if
 * none. This is the id -> element back-mapping the viewport uses to isolate the
 * single hovered primitive. Because the key is layer-qualified, a pick key minted
 * by another layer (or a null) never matches, so a hovered vertex cannot resolve
 * to a same-index edge or face.
 */
export function pickedPrimitiveIndex(
  bodyKey: string,
  count: number,
  layer: string,
  pickKey: string | null,
): number {
  if (pickKey === null) return -1
  return parsePickKeyIndex(pickKey, `${bodyKey}#${layer}#`, count)
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
 */
export function pickedIndicesForBody(
  pickKeys: ReadonlySet<string>,
  bodyKey: string,
  layer: string,
): Set<number> | null {
  if (pickKeys.size === 0) return null
  const prefix = `${bodyKey}#${layer}#`
  let out: Set<number> | null = null
  for (const key of pickKeys) {
    const idx = parsePickKeyIndex(key, prefix)
    if (idx < 0) continue
    if (!out) out = new Set<number>()
    out.add(idx)
  }
  return out
}

/** Index encoded in `key` when it carries `prefix`, else -1. `count`, when given,
 *  bounds the index to the primitives the caller actually has. */
function parsePickKeyIndex(key: string, prefix: string, count = Infinity): number {
  if (!key.startsWith(prefix)) return -1
  const tail = key.slice(prefix.length)
  // Reject anything that is not a bare non-negative integer: a body key
  // containing '#' could otherwise let a foreign key parse as an index.
  if (!/^\d+$/.test(tail)) return -1
  const idx = Number(tail)
  return idx < count ? idx : -1
}
