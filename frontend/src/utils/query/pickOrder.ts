/**
 * pickOrder.ts -- build-order guard for pick chips.
 *
 * A feature may only reference geometry produced by features *before* it in the
 * stack. Referencing its own output (extrude1 picking a face of extrude1) or a
 * later feature's output is a circular dependency: the solver would have to know
 * the result of the feature it is about to build. The viewport happily renders
 * the edited feature's preview body, so nothing else stops the user from
 * clicking it -- this module is that stop.
 */
import { parseQuery } from '@/utils/query'

// Selection ids that name their owning feature in the segment after the prefix.
const OWNER_PREFIXES = ['entity:', 'vertex:', 'face:', 'edge:', 'constraint:', 'dock:', 'isect:']

const BODY_PREFIX = 'body_'

/**
 * Resolve an ancestor token to the feature that owns it. Handles the three
 * shapes `ref()` and the query builders emit: a bare `@<featureId>`, the topo
 * fallback `@<featureId>/face/3`, and the slash-joined absolute `@<featureId>/<eid>`.
 * Geom-descriptor tokens (`@gdf|...`), classifiers and builtin planes own no
 * feature and resolve to null. The concatenated `@<featureId><eid>` form is a
 * legacy fallback for tokens persisted before the slash-joined format.
 *
 * Exported for the label resolver (queryLabel) so display text and the pick
 * guard answer "which feature owns this token" the same way.
 */
export function featureIdOfToken(token: string, known: ReadonlySet<string>): string | null {
  if (!token.startsWith('@')) return null
  let id = token.slice(1)
  const slash = id.indexOf('/')
  if (slash >= 0) id = id.slice(0, slash)
  if (known.has(id)) return id

  // A body is named after the feature that first created it -- but that feature
  // can own several bodies, and split siblings carry a `_1`, `_2` suffix
  // (kernel/features/bodySplit.ts). Strip the prefix and fall through to the
  // longest-known-prefix match below, so `@body_ex1_1` still attributes to
  // `ex1`. Stripping and demanding an EXACT hit resolved every sibling to
  // null, and this guard fails open, so each sibling silently became pickable
  // by the feature that made it.
  if (id.startsWith(BODY_PREFIX)) {
    id = id.slice(BODY_PREFIX.length)
    if (known.has(id)) return id
  }

  // `@<featureId><eid>` (legacy concatenated tokens) has no separator, so the
  // feature id can only be recovered by matching against the ids that actually
  // exist. Longest wins: with both `ex1` and `ex12` present, `@ex12face0`
  // belongs to `ex12`.
  let best: string | null = null
  for (const f of known) {
    if (id.startsWith(f) && (best === null || f.length > best.length)) best = f
  }
  return best
}

/** Every feature a selection id derives from, restricted to ids in `known`. */
export function selectionSourceFeatureIds(selectionId: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>()

  for (const prefix of OWNER_PREFIXES) {
    if (!selectionId.startsWith(prefix)) continue
    const rest = selectionId.slice(prefix.length)
    const colon = rest.indexOf(':')
    const owner = colon < 0 ? rest : rest.slice(0, colon)
    if (known.has(owner)) out.add(owner)
    // `face:`/`edge:` wrap an inner query whose tokens may name more features.
    if (colon >= 0) {
      for (const f of selectionSourceFeatureIds(rest.slice(colon + 1), known)) out.add(f)
    }
    return [...out]
  }

  if (selectionId.startsWith('?')) {
    try {
      const q = parseQuery(selectionId)
      if (q.kind !== 'ancestry') return []
      for (const id of q.ancestorIds) {
        const f = featureIdOfToken(id, known)
        if (f) out.add(f)
      }
    } catch {
      return []  // unparseable query: nothing to attribute, let the pick through
    }
    return [...out]
  }

  const f = featureIdOfToken(selectionId, known)
  return f ? [f] : []
}

/**
 * Whether `hostFeatureId` may reference `selectionId`. False when the selection
 * comes from the host itself or from a feature built after it.
 *
 * Fails open: a host that is not in `features`, or a selection that names no
 * known feature (builtin planes, geom-hash tokens), is always allowed.
 */
export function isPickAllowed(
  selectionId: string,
  hostFeatureId: string,
  features: readonly { id: string }[],
): boolean {
  const order = new Map<string, number>()
  features.forEach((f, i) => order.set(f.id, i))
  const host = order.get(hostFeatureId)
  if (host === undefined) return true

  for (const src of selectionSourceFeatureIds(selectionId, new Set(order.keys()))) {
    const idx = order.get(src)
    if (idx !== undefined && idx >= host) return false
  }
  return true
}
