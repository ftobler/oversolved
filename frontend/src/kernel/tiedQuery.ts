// The last resort that keeps every edge and vertex query of a body resolvable,
// the analogue of the face index tag in faceQuery.ts.

import { makeAncestryQuery, emitWire, absolute } from "./query"

/** One element's query before it is emitted: its ancestral ids and type restriction. */
export interface QueryParts {
  ids: string[]
  type: string
  // Whether the element carries a construction uuid. A uuid query is never
  // tagged: the uuid tier resolves it, and its string must stay copy-stable.
  named: boolean
}

/**
 * Emit one query per element, adding the registrar's own per-index ancestor tag
 * (`@<body>/<kind>N`, builderAncestry `_registerBrepEdgeAncestry` and its vertex
 * twin) to an unnamed element whose query would otherwise be byte-identical to
 * a sibling's. Such a pair resolves to several elements and the pick throws
 * AmbiguousQueryError, so a tag that makes it unique is strictly better.
 *
 * An index is not stable identity: after a rebuild that reorders the body's
 * elements it names whichever one took the slot. It is only reached when the
 * symbolic tiebreaks (split ordering, then the named faces at an edge's ends or
 * the named edges at a vertex) all left the element indistinguishable, and a
 * query with no tie is left exactly as it was.
 */
export function emitWithTiesTagged(parts: readonly QueryParts[], bodyId: string, kind: "edge" | "vertex"): string[] {
  const plain = parts.map((p) => makeAncestryQuery(p.ids, p.type))
  const count = new Map<string, number>()
  for (const q of plain) count.set(q, (count.get(q) ?? 0) + 1)
  return parts.map((p, i) => {
    if (p.named || count.get(plain[i])! < 2) return plain[i]
    return makeAncestryQuery([...p.ids, emitWire(absolute(bodyId, `${kind}${i}`))], p.type)
  })
}
