// Construction-name identity: face query string builder (query-naming-by-construction).
// The construction UUID (@u|) is the sole geometry-independent identity token; only the
// UUID + ancestral tokens + classifiers remain in a persisted face query.

import { ref, makeAncestryQuery, constructionUuidToken, emitWire, absolute } from "./query"

/** Ancestry query string for a face, or null if createdBy is absent. A face of a
 *  body always gets one: see the last resort below. */
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
    // Last resort: no construction UUID, no face ancestry, no classifiers. The
    // rest of the net (createdBy+bodyId+body-wide profile queries) is
    // byte-identical for every sibling in that state, and the resolver throws
    // AmbiguousQueryError on the pick. Every face of a body still needs a real
    // query (an empty one left the render layer an index-keyed fallback no
    // feature resolves), so this one carries the registrar's own per-index
    // ancestor tag (builderAncestry `_registerBrepFaceAncestry`), which makes it
    // unique. An index is not stable identity: after a rebuild that reorders the
    // body's faces it names whichever face took the slot. The neighbour naming
    // pass runs in rounds and names every face connected to a named one, so few
    // faces land here: a face on a body whose producer named nothing at all, and
    // a near-tie group the split ordering refused that is still tied once a round
    // names nothing more. A refused group is not given up on at once; each later
    // round that names a neighbour of it retries it with the larger neighbour set.
    if (!uuid && !(ancestorTokens && ancestorTokens.length) && !(classifiers && classifiers.length)) {
      const ids = [ref(createdBy), ref(bodyId), emitWire(absolute(bodyId, `face${faceIdx}`))]
      if (profileQueries && profileQueries.length) ids.push(...profileQueries)
      return makeAncestryQuery(ids, surfaceType)
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
