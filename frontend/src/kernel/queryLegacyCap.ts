// The pure recompute behind the legacy cap hand-off (plan
// bug-multi-region-cap-identity). It lives beside the query engine so the
// resolver can apply it at the UUID tier for every consumer, not just the face
// and edge leaves that each used to need their own retry.

import {
  isClassifierId,
  isConstructionUuidId,
  parseConstructionUuidId,
} from './queryWire'
import {
  capFacePath,
  capRegionKey,
  legacyCapFacePath,
  mintFaceUuid,
} from './constructionName'

/** The `@<sketchId>/<entityId>` tokens a cap query carries. */
export function capProfileSlots(ids: string[]): string[] {
  return ids.filter((id) => {
    if (!id.startsWith('@') || isConstructionUuidId(id) || isClassifierId(id)) return false
    const parts = id.slice(1).split('/')
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
  })
}

/** The one authored-feature token a cap query names (its creator), if exactly one. */
export function capCreatorOf(ids: string[]): string | null {
  const features = ids.filter((id) => {
    if (!id.startsWith('@') || isConstructionUuidId(id) || isClassifierId(id)) return false
    const token = id.slice(1)
    if (token.includes('/')) return false
    if (token.startsWith('body_') || token.startsWith('builtin_')) return false
    return token.length > 0
  })
  return features.length === 1 ? features[0].slice(1) : null
}

/**
 * The live uuid a dead bare cap path means, recomputed from the query's own
 * profile entities. Null when the dead uuid is not a bare cap path, when the
 * query names no single creator or region, or when the start and end recompute
 * both match (a collision the hand-off refuses).
 *
 * A `g<i>` path never matches: the group index is exactly the unreliable part.
 */
export function legacyCapUuid(ids: string[], deadUuid: string): string | null {
  const uuidTokens = ids
    .map(parseConstructionUuidId)
    .filter((uuid): uuid is string => uuid !== null)
  if (uuidTokens.length !== 1) return null
  const creator = capCreatorOf(ids)
  if (creator === null) return null
  const slots = capProfileSlots(ids)
  if (slots.length === 0) return null

  let which: 'start' | 'end' | null = null
  for (const candidate of ['start', 'end'] as const) {
    if (mintFaceUuid(legacyCapFacePath(creator, candidate)) !== deadUuid) continue
    if (which !== null) return null
    which = candidate
  }
  if (which === null) return null
  return mintFaceUuid(capFacePath(creator, which, capRegionKey(slots)))
}
