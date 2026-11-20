// The repository-level hand-offs for stored picks minted before caps were keyed
// by their region's own profile entities (plan bug-multi-region-cap-identity).
//
// The old producer named a single-group cap `<createdBy>|cap|<which>` and a
// multi-group cap `<createdBy>|cap|<which>|g<index>`. Both are dead now. Only
// the bare form can be recovered, and only when the query's own lineage proves
// which live element it means. A `g<i>` pick is never recovered (the index is
// the unreliable part), and a bare pick whose tokens carried another region's
// entities (the RC2 damage) does not recompute a live cap. Both go red, which is
// the fail-safe outcome.

import type { Repository } from '../../query'
import { parseAncestry, parseConstructionUuidId } from '../../query'
import type { PartSolid } from '../../types3d'
import {
  capFacePath,
  capRegionKey,
  deriveEdgeUuid,
  legacyCapFacePath,
  mintFaceUuid,
} from '../../constructionName'
import { capCreatorOf, capProfileSlots, legacyCapUuid } from '../../queryLegacyCap'

/**
 * Resolve `query` when its construction UUID is the dead bare cap path, by
 * recomputing the region key from the query's own profile entities. Returns the
 * live registered element, or null when this is not a verified hand-off.
 */
export function resolveLegacyCapQuery(repo: Repository, query: string): unknown | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  const uuidTokens = ids
    .map(parseConstructionUuidId)
    .filter((uuid): uuid is string => uuid !== null)
  if (uuidTokens.length !== 1) return null
  const deadUuid = uuidTokens[0]
  // A live uuid is the caller's business; the migration only replaces a miss.
  if ((repo.byUuid.get(deadUuid) ?? []).some((eid) => repo.elements.has(eid))) return null

  const newUuid = legacyCapUuid(ids, deadUuid)
  if (newUuid === null) return null
  const live = (repo.byUuid.get(newUuid) ?? []).filter((eid) => repo.elements.has(eid))
  if (live.length !== 1) return null
  return repo.elements.get(live[0]) ?? null
}

/** How many shared edges one face pair may have before the migration gives up. */
const MAX_EDGE_MULTIPLICITY = 8

/**
 * Resolve a stored fillet/chamfer edge pick that lay on a legacy cap rim.
 *
 * An edge uuid is `deriveEdgeUuid(faceA, faceB)`, so moving every cap changed
 * every cap rim edge. The query carries the side entity's tokens, and the body
 * carries each cap's new region tokens (`face_cap_ancestry`) and each side
 * face's tokens (`face_ancestry`). Rebuild the dead pair from the bare legacy
 * cap uuid and the one live side it borders, then require the recomputed new
 * edge to be live. A side entity that reaches several faces (a split side) is
 * ambiguous and stays red; a legacy `g<i>` cap has no bare recompute at all.
 */
export function resolveLegacyCapRimQuery(
  repo: Repository,
  query: string,
  part: Pick<PartSolid, 'face_uuids' | 'face_ancestry' | 'face_cap_ancestry'>,
): unknown | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  const uuidTokens = ids
    .map(parseConstructionUuidId)
    .filter((uuid): uuid is string => uuid !== null)
  if (uuidTokens.length !== 1) return null
  const deadUuid = uuidTokens[0]
  if ((repo.byUuid.get(deadUuid) ?? []).some((eid) => repo.elements.has(eid))) return null

  const creator = capCreatorOf(ids)
  if (creator === null) return null
  const slots = capProfileSlots(ids)
  if (slots.length === 0) return null

  const faceAncestry = part.face_ancestry ?? {}
  const capAncestry = part.face_cap_ancestry ?? {}
  const liveFaceUuids = (part.face_uuids ?? []).filter((uuid): uuid is string => uuid !== null)

  // The side entity a rim edge borders must reach exactly one live face; a
  // split side has no single uuid to derive the old pair from.
  let matched: { which: 'start' | 'end'; sideUuid: string; slot: string; multiplicity: number } | null = null
  for (const slot of slots) {
    const sides = liveFaceUuids.filter((uuid) => (faceAncestry[uuid] ?? []).includes(slot))
    if (sides.length !== 1) continue
    const sideUuid = sides[0]
    for (const which of ['start', 'end'] as const) {
      const legacyCap = mintFaceUuid(legacyCapFacePath(creator, which))
      for (let multiplicity = 0; multiplicity < MAX_EDGE_MULTIPLICITY; multiplicity++) {
        if (deriveEdgeUuid(legacyCap, sideUuid, multiplicity) !== deadUuid) continue
        if (matched !== null) return null  // more than one way to read the pick
        matched = { which, sideUuid, slot, multiplicity }
      }
    }
  }
  if (matched === null) return null

  // Exactly one live cap region borders that side; its own token list is the
  // new region key, so the recomputed cap identity is the region's.
  const regions = new Set<string>()
  for (const capUuid of liveFaceUuids) {
    const tokens = capAncestry[capUuid]
    if (tokens === undefined || !tokens.includes(matched.slot)) continue
    regions.add(capRegionKey(tokens))
  }
  if (regions.size !== 1) return null
  const newCapUuid = mintFaceUuid(capFacePath(creator, matched.which, [...regions][0]))
  const newEdgeUuid = deriveEdgeUuid(newCapUuid, matched.sideUuid, matched.multiplicity)
  const live = (repo.byUuid.get(newEdgeUuid) ?? []).filter((eid) => repo.elements.has(eid))
  if (live.length !== 1) return null
  return repo.elements.get(live[0]) ?? null
}
