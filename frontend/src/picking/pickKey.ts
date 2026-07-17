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
 * `layer` is load-bearing: the store's `hoveredPickKey` / `selectedPickKeys` hold
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
