import type { Query, LocalQuery, AbsoluteQuery, AncestryQuery } from "@/types/query"

/**
 * Convert a Query to its wire-format string.
 *
 * Call ONLY at true serialization boundaries:
 *   - writing into a PartDoc / YAML field
 *   - constructing an ancestry id list inside q.ancestry()
 *   - React keys or Set members where an opaque stable string is needed
 *
 * Do NOT call to compare queries -- use structural equality on the objects.
 * Do NOT call to inspect kind -- use q.kind.
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

// Vertex-key suffixes a local query may carry. The ellipse axis-endpoint keys
// (major1/major2/minor1/minor2) sit alongside the base line/arc/circle keys so
// `$<eid>major1` round-trips to { eid, sub: 'major1' }.
const LOCAL_SUBS = ["start", "end", "center", "xy", "major1", "major2", "minor1", "minor2"] as const

function _parseLocal(s: string): LocalQuery {
  const body = s.slice(1)
  for (const pt of LOCAL_SUBS) {
    if (body.length > pt.length && body.endsWith(pt))
      return { kind: "local", eid: body.slice(0, -pt.length), sub: pt }
  }
  return { kind: "local", eid: body }
}

function _parseAbsolute(s: string): AbsoluteQuery {
  // feature_id / eid split is resolved by the backend resolver
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

/** Constructor helpers -- callers never need to call emitWire themselves. */
export const q = {
  local: (eid: string, sub?: string): LocalQuery =>
    ({ kind: "local", eid, sub }),
  absolute: (featureId: string, eid?: string, sub?: string): AbsoluteQuery =>
    ({ kind: "absolute", featureId, eid, sub }),
  // Accepts Query objects so callers never have to call emitWire just to
  // pass something into ancestry.
  ancestry: (ids: (Query | string)[], typeRestriction?: string, classifier?: string): AncestryQuery => ({
    kind: "ancestry",
    ids: ids.map(i => typeof i === "string" ? i : emitWire(i)),
    typeRestriction,
    classifier,
  }),
}
