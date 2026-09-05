// Construction-name identity: face query string builder (query-naming-by-construction).
// The construction UUID (@u|) is the sole geometry-independent identity token; only the
// UUID + ancestral tokens + classifiers remain in a persisted face query.

import { ref, makeAncestryQuery, constructionUuidToken } from "./query"

/** Ancestry query string for a face, or null if createdBy is absent. */
export function buildFaceQuery(
  createdBy: string | null | undefined,
  bodyId: string | null | undefined,
  faceIdx: number,
  surfaceType: string,
  profileQueries: string[] | null = null,
  ancestorTokens: string[] | null = null,
  classifiers: string[] | null = null,
  uuid: string | null = null,
): string | null {
  if (!createdBy) return null
  if (bodyId) {
    // Collision guard: without the construction UUID the query carries no
    // per-face identity token. `faceIdx` is deliberately excluded (an index is
    // not stable identity; the render layer's topoFallbackQuery exists for
    // that), so when the face also supplies no distinguishing ancestry or
    // classifiers the minted string is createdBy+bodyId(+body-wide profile
    // queries) -- byte-identical for every sibling sharing that ancestry, and
    // the resolver throws AmbiguousQueryError on the pick. Return null so the
    // caller falls back to the index-keyed topoFallbackQuery instead.
    if (!uuid && !(ancestorTokens && ancestorTokens.length) && !(classifiers && classifiers.length)) {
      return null
    }
    const ids: string[] = []
    if (uuid) ids.push(constructionUuidToken(uuid))
    ids.push(ref(createdBy), ref(bodyId))
    if (ancestorTokens && ancestorTokens.length) ids.push(...ancestorTokens)
    else if (profileQueries && profileQueries.length) ids.push(...profileQueries)
    if (classifiers && classifiers.length) ids.push(...classifiers.map(ref))
    return makeAncestryQuery(ids, surfaceType)
  }
  const elementId = `face${faceIdx}`
  const absId = ref(createdBy) + "/" + elementId
  return makeAncestryQuery([absId, ref(createdBy)], surfaceType)
}
