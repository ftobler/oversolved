import type { Query, LocalQuery, AbsoluteQuery, AncestryQuery } from "@/types/query"
import { VERTEX_POINT_KEYS } from "@/types/vertexKeys"

/**
 * Convert a Query to its wire-format string.
 *
 * Call ONLY at true serialization boundaries:
 *   - writing into a PartDoc / YAML field
 *   - React keys or Set members where an opaque stable string is needed
 *
 * Do NOT call to compare queries -- use structural equality on the objects.
 * Do NOT call to inspect kind -- use the `kind` field directly.
 * If you find yourself calling this just to pass the value somewhere else,
 * keep the Query object instead.
 */
export function emitWire(q: Query): string {
  switch (q.kind) {
    case "local":
      return "$" + q.eid + (q.sub ?? "")
    case "absolute":
      return "@" + q.featureId + (q.eid ?? "") + (q.sub ?? "")
    case "ancestry": {
      const lengths = q.ids.map(i => i.length.toString(16)).join(",")
      let s = "?" + lengths + ";" + q.ids.join("")
      if (q.typeRestriction) s += ":" + q.typeRestriction
      if (q.classifier) s += "@" + q.classifier
      return s
    }
  }
}

export function parseQuery(s: string): Query {
  if (s.startsWith("$")) return _parseLocal(s)
  if (s.startsWith("@")) return _parseAbsolute(s)
  if (s.startsWith("?")) return _parseAncestry(s)
  throw new Error(`Unrecognized query string: ${s}`)
}

function _parseLocal(s: string): LocalQuery {
  const body = s.slice(1)
  for (const pt of VERTEX_POINT_KEYS) {
    if (body.length > pt.length && body.endsWith(pt))
      return { kind: "local", eid: body.slice(0, -pt.length), sub: pt }
  }
  return { kind: "local", eid: body }
}

function _parseAbsolute(s: string): AbsoluteQuery {
  // feature_id / eid split is resolved by the query resolver
  return { kind: "absolute", featureId: s.slice(1) }
}

function _parseAncestry(s: string): AncestryQuery {
  const semi = s.indexOf(";")
  const lengths = s.slice(1, semi).split(",").map(h => parseInt(h, 16))
  let rest = s.slice(semi + 1)
  let typeRestriction: string | undefined
  let classifier: string | undefined
  const ids: string[] = []
  for (const len of lengths) {
    ids.push(rest.slice(0, len))
    rest = rest.slice(len)
  }
  if (rest.startsWith(":")) {
    const at = rest.indexOf("@", 1)
    if (at >= 0) {
      typeRestriction = rest.slice(1, at)
      classifier = rest.slice(at + 1)
    } else {
      typeRestriction = rest.slice(1)
    }
  }
  return { kind: "ancestry", ids, typeRestriction, classifier }
}


