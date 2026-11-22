/**
 * The one extension label left after the slab route was deleted.
 *
 * The old ladder (widened UV patches, ruled strips, two unbound OCCT probes)
 * existed only to rebuild a neighbour as a splitter across a slab. The direct
 * move-face tweak rebuilds changed edges from surface intersections and needs
 * no extension at all. Defeature's wedge support still builds one bounded
 * analytic face, so its refusal quotes this label; there is nothing else left
 * to probe.
 */

export const RUNG_1 = 'rung 1 (exact analytic window)'

/** The extension a refusal attempted, in the one-entry form the messages use. */
export function rungCatalog(_oc: unknown): string {
  return `${RUNG_1}: exact for plane, cylinder, cone, sphere and torus; a freeform surface has no analytic primitive`
}
