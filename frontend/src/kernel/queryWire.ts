// The `$` / `@` / `?` wire-format codec: typed-query constructors, string
// parsing/emission, ancestry framing, and the wire-token predicates. Split out
// of query.ts so the Repository engine and the codec can evolve separately; the
// query.ts barrel re-exports the public surface unchanged.

import { failLoud } from '@/utils/invariants'
import { isDevOrTestBuild } from './isDevBuild'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import type { LocalQuery, AbsoluteQuery, AncestryQuery, Query } from '@/types/query'

/** Local alias for the canonical Query union (re-exported by query.ts as QueryType). */
type QueryType = Query

/** Surface a wire-format ambiguity in dev/test only. Minted base64url entity
 *  ids routinely end in a vertex-key word (a bare id ending in "xy" or "start"
 *  is a real, frequently-minted shape), and the kernel parser cannot see the
 *  entity-id set, so a loud failure here would break production writes. The
 *  knownIds readers (resolveLocal / resolveQueryRef) are the resolver for these
 *  strings; emitWire just warns so the ambiguity is never silently hidden. */
const warnWireAmbiguity = isDevOrTestBuild()
  ? (...args: unknown[]) => console.warn(...args)
  : () => undefined

export function local(eid: string, sub = ""): LocalQuery {
  return { kind: "local", eid, sub }
}
export function absolute(featureId: string, eid = "", sub = ""): AbsoluteQuery {
  return { kind: "absolute", featureId, eid, sub }
}
export function ancestry(
  ids: (Query | string)[],
  typeRestriction: string | null = null,
  classifier: string | null = null,
): AncestryQuery {
  const wireIds = ids.map(i => (typeof i === "string" ? i : emitWire(i)))
  return { kind: "ancestry", ancestorIds: wireIds, typeRestriction, classifier }
}

/** Pure-word suffixes: a local ending in one of these is a sub-point reference
 *  even when the residual is not a minted id shape, because a real entity id
 *  ending in a plain English word is contrived while these refs are the common
 *  case. The digit-bearing suffixes (c1/c2/major1/...) need the residual to be
 *  a plausible id instead -- "arc1" must stay a bare local (residual "ar"). */
const ALPHA_SUFFIXES = new Set(["start", "end", "center", "xy"])

/** Legacy sketch entity ids (e3, line1, ell1, a1): lowercase letters and/or
 *  digits, with at least one digit so a leftover word ("ar", "my") is never
 *  taken for an id. Base64url ids (uppercase / `-` / `_`) are deliberately
 *  excluded: the app mints those constantly, and a long mixed-case token ending
 *  in a digit-bearing suffix must stay a bare local ("...Huc2" is a real id,
 *  not eid "...Hu" sub "c2"). */
function isPlausibleEntityId(s: string): boolean {
  if (s.length === 0) return false
  if (!/^[a-z0-9]+$/.test(s)) return false
  return /[0-9]/.test(s)
}

export function localFromString(s: string): LocalQuery {
  const body = s.slice(1)
  // Canonical local-parse rule (wire-format-hardening): a suffix word splits
  // only when the split is unambiguous. A suffix is split when it is a pure
  // English word (start/end/center/xy), OR it is digit-bearing and the residual
  // is a plausible legacy id (lowercase alnum with a digit). "$a1xy" reads eid
  // "a1" sub "xy" (pure word); "$arc1" reads eid "arc1" (residual "ar" is not
  // an id); a base64url id ending in "c2" reads as one id. This parser is
  // context-free and cannot see the entity-id set, so a bare id that lands on
  // the split side (e.g. a minted id ending in "xy") is read as eid+sub here;
  // the knownIds consumers (resolveLocal / resolveQueryRef) disambiguate those
  // strings by full entity-id membership. emitWire warns in dev/test when its
  // output re-parses differently rather than throwing.
  for (const pt of VERTEX_POINT_KEYS) {
    if (body.length > pt.length && body.endsWith(pt)) {
      const residual = body.slice(0, -pt.length)
      if (ALPHA_SUFFIXES.has(pt) || isPlausibleEntityId(residual))
        return { kind: "local", eid: residual, sub: pt }
    }
  }
  return { kind: "local", eid: body, sub: "" }
}

/** Slash key for a `$` local: `context + eid` for a bare local, `context +
 *  eid + "/" + sub` for a sub-point. This is the shape
 *  `registerSolvedGeometrySlash` registers (`featureId/eid/sub`). */
export function localKeyFor(context: string, q: LocalQuery): string {
  return q.sub ? context + q.eid + "/" + q.sub : context + q.eid
}

export function parseQuery(s: string): QueryType {
  if (s.startsWith("$")) return localFromString(s)
  if (s.startsWith("@")) return parseAbsolute(s)
  if (s.startsWith("?")) return parseAncestryObj(s)
  throw new Error(`Unrecognized query string: ${JSON.stringify(s)}`)
}

/** Serialize a typed query to its wire-format string. */
export function emitWire(q: QueryType): string {
  switch (q.kind) {
    case "local": {
      const wire = "$" + q.eid + (q.sub ?? "")
      // The `$eid[sub]` grammar is inherently ambiguous between {eid, sub} and
      // a longer eid: minted base64url ids end in pure-word suffixes routinely,
      // while `$pwfYD59xKWiSyQhmcenter` is a real persisted sub-point. The
      // kernel parser picks one deterministic reading (see localFromString); the
      // knownIds consumers (resolveLocal / resolveQueryRef) are the resolver
      // and disambiguate by full entity-id membership. When the two readings
      // diverge we surface it in dev/test only -- never a prod throw, since a
      // minted id can land on either side.
      const reparsed = localFromString(wire)
      if (reparsed.eid !== q.eid || reparsed.sub !== (q.sub ?? "")) {
        warnWireAmbiguity(
          `local query ${JSON.stringify(wire)} is ambiguous on the wire: the kernel ` +
            `reads it as eid ${JSON.stringify(reparsed.eid)} sub ${JSON.stringify(reparsed.sub)}; ` +
            `the knownIds readers resolve it by full entity-id membership`,
        )
      }
      return wire
    }
    case "absolute": {
      // The wire grammar needs a featureId and, for a sub, an eid: a bare "@"
      // is unparseable and "@feat/sub" reads back as eid "sub". Both shapes are
      // programming errors, so fail loud (throw in test) instead of emitting a
      // wrong or unparseable string.
      if (!q.featureId) {
        failLoud(
          `emitWire: absolute query without a featureId cannot be framed ` +
            `(the bare "@" form is unparseable)`,
        )
        return ""
      }
      if (q.sub && !q.eid) {
        failLoud(
          `emitWire: absolute query with sub ${JSON.stringify(q.sub)} but no eid ` +
            `cannot be framed (a sub has no wire slot without an eid; "@feat/sub" ` +
            `would parse back as eid "sub")`,
        )
        return "@" + q.featureId
      }
      if (q.eid) return "@" + q.featureId + "/" + q.eid + (q.sub ? "/" + q.sub : "")
      return "@" + q.featureId
    }
    case "ancestry":
      // Delegate to makeAncestryQuery so the wire tail (:type@cls) is validated
      // once: the ids are length-framed but the tail is raw concatenation, so an
      // ill-formed restriction/classifier would silently re-parse differently
      // (see makeAncestryQuery).
      return makeAncestryQuery(q.ancestorIds, q.typeRestriction, q.classifier)
  }
}

export function parseAbsolute(s: string): AbsoluteQuery {
  const body = s.slice(1)
  const parts = body.split("/")
  // Strict: emitWire can only produce 1-3 non-empty slash parts (the legacy
  // concatenated `@feat+eid` reads back as the single-part featureId = whole
  // tail). An empty part or a 4+ part key is a shape the typed path cannot
  // construct, so it is rejected loudly instead of silently canonicalized.
  if (parts.length > 3 || parts.some(p => p.length === 0)) {
    throw new Error(`Unrecognized absolute query format: ${JSON.stringify(s)}`)
  }
  if (parts.length === 1) return { kind: "absolute", featureId: parts[0], eid: "", sub: "" }
  if (parts.length === 2) return { kind: "absolute", featureId: parts[0], eid: parts[1], sub: "" }
  return { kind: "absolute", featureId: parts[0], eid: parts[1], sub: parts[2] }
}

function parseAncestryObj(s: string): AncestryQuery {
  const [ids, typeRestriction, classifier] = parseAncestry(s)
  return { kind: "ancestry", ancestorIds: ids, typeRestriction: typeRestriction || null, classifier: classifier || null }
}

/** Mint an ancestor token referencing a feature/body/geom-hash: "@<id>". */
export function ref(elementId: string): string {
  return "@" + elementId
}

const BODY_AT_RE = /@(body_[^@:;,/]+)/g

/** Return the body id ("body_...") a query refers to, or null. */
export function bodyIdOf(queryStr: string, bodyStore?: Record<string, unknown> | null): string | null {
  const candidates: string[] = []
  let m: RegExpExecArray | null
  BODY_AT_RE.lastIndex = 0
  while ((m = BODY_AT_RE.exec(queryStr)) !== null) candidates.push(m[1])
  // Only a store-verified body id is authoritative: BODY_AT_RE's greedy capture
  // can frame a fabricated id out of concatenated ancestor tokens (e.g.
  // "@body_abc" + "x1" frames "@body_abcx1"), so an absent store or one holding
  // no candidate must return null, never the unverified first capture. Call
  // sites treat the result as a hint with a full-store fallback.
  if (bodyStore == null) return null
  for (const c of candidates) if (c in bodyStore) return c
  return null
}

/** Parse `?A,B;<idA><idB>` or `...:<TYPE>` or `...:<TYPE>@<cls>`.
 *  Returns [ids, typeRestriction, classifier|null]. The classifier suffix after
 *  `:type` is a first-class field, never swallowed into the typeRestriction. */
export function parseAncestry(queryStr: string): [string[], string | null, string | null] {
  if (!queryStr.startsWith("?")) {
    throw new Error(`Invalid ancestry query: ${JSON.stringify(queryStr)}`)
  }
  const semi = queryStr.indexOf(";")
  if (semi < 0) {
    throw new Error(`ancestry query truncated: missing ';' in ${JSON.stringify(queryStr)}`)
  }
  const lengthsHex = queryStr.slice(1, semi)
  const rest = queryStr.slice(semi + 1)

  const lengths = lengthsHex.split(",").map(x => {
    const n = parseInt(x, 16)
    if (Number.isNaN(n) || !/^[0-9a-fA-F]+$/.test(x)) {
      throw new Error(`invalid hex length field in ancestry query ${JSON.stringify(queryStr)}`)
    }
    return n
  })

  const ids: string[] = []
  // The canonical empty form: a single "0" length field frames zero ids (what
  // makeAncestryQuery([]) emits). A zero in any other position is a real
  // zero-length segment and is rejected in the loop below.
  if (lengths.length === 1 && lengths[0] === 0) {
    const [typeRestriction, classifier] = parseAncestryTail(rest, queryStr)
    return [ids, typeRestriction, classifier]
  }

  let pos = 0
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]
    if (length === 0) {
      throw new Error(
        `zero-length segment at index ${i} in ancestry query ${JSON.stringify(queryStr)}`,
      )
    }
    if (pos + length > rest.length) {
      throw new Error(
        `ancestry string truncated at position ${pos}: segment ${i} needs ${length} bytes ` +
          `but only ${rest.length - pos} remain`,
      )
    }
    ids.push(rest.slice(pos, pos + length))
    pos += length
  }

  let typeRestriction: string | null = null
  let classifier: string | null = null
  if (pos < rest.length) {
    const [t, c] = parseAncestryTail(rest.slice(pos), queryStr)
    typeRestriction = t
    classifier = c
  }
  return [ids, typeRestriction, classifier]
}

/** Parse the `[:type][@cls]` tail after the framed ids. Anything else throws so
 *  malformed framing fails loud instead of silently dropping bytes ("?3;abcdef"
 *  used to swallow the "def"). An empty ":type" is null (the same as no
 *  restriction), which is how "?2;@a:" reads back. */
function parseAncestryTail(tail: string, queryStr: string): [string | null, string | null] {
  if (tail.length === 0) return [null, null]
  if (tail.startsWith(":")) {
    const at = tail.indexOf("@", 1)
    if (at >= 0) {
      return [tail.slice(1, at) || null, tail.slice(at + 1) || null]
    }
    return [tail.slice(1) || null, null]
  }
  if (tail.startsWith("@")) {
    return [null, tail.slice(1) || null]
  }
  throw new Error(
    `unconsumed trailing data in ancestry query ${JSON.stringify(queryStr)}: ${JSON.stringify(tail)}`,
  )
}

/** Build an ancestry query string from a list of id strings. */
export function makeAncestryQuery(
  ids: string[],
  typeRestriction: string | null = null,
  classifier: string | null = null,
): string {
  // An empty id is un-frameable: "?0;" reads back as zero ids, so emitting one
  // would silently lose it.
  if (ids.some(i => i.length === 0)) {
    throw new Error(`ancestry query cannot frame an empty id: ${JSON.stringify(ids)}`)
  }
  // An empty id list is framed as "?0;" (the parseable canonical form; "?;"
  // has an empty length header that parseAncestry rejects).
  const lengths = ids.length ? ids.map(i => i.length.toString(16)).join(",") : "0"
  let s = "?" + lengths + ";" + ids.join("")
  // The :type@cls tail is raw concatenation after length-framed ids, so a
  // character parseAncestryTail would re-read differently is a silent
  // round-trip corruption: "fo@o" emits ":fo@o", which parses back as type
  // "fo" classifier "o". Reject the two characters that split the tail grammar
  // instead of emitting a string that re-parses into a different query.
  if (typeRestriction !== null && (typeRestriction.includes("@") || typeRestriction.includes(":"))) {
    throw new Error(
      `ancestry query type restriction ${JSON.stringify(typeRestriction)} contains ` +
        `'@' or ':' and would not round-trip`,
    )
  }
  if (classifier != null && (classifier.includes("@") || classifier.includes(":"))) {
    throw new Error(
      `ancestry query classifier ${JSON.stringify(classifier)} contains ` +
        `'@' or ':' and would not round-trip`,
    )
  }
  // An empty type restriction is null on the wire: never emit a trailing ":".
  if (typeRestriction) s += ":" + typeRestriction
  if (classifier) s += "@" + classifier
  return s
}

/** Wire-format geometric-classifier token (@cls_*). */
export function isClassifierId(idStr: string): boolean {
  return idStr.startsWith("@cls_")
}

/** Wire-format geom_hash reference (@gface_/@gedge_/@gvertex_/@gnormal_). */
export function isGeomHashId(idStr: string): boolean {
  return (
    idStr.startsWith("@gface_") ||
    idStr.startsWith("@gedge_") ||
    idStr.startsWith("@gvertex_") ||
    idStr.startsWith("@gnormal_")
  )
}

// ─── construction-by-name UUID token (query-naming-by-construction) ───

const UUID_TOKEN_PREFIX = "@u|"

/** Wire-format construction UUID token (`@u|<uuid>`), the primary identity. */
export function isConstructionUuidId(idStr: string): boolean {
  return idStr.startsWith(UUID_TOKEN_PREFIX)
}

/** Mint the wire token `@u|<uuid>` for a construction UUID. */
export function constructionUuidToken(uuid: string): string {
  return UUID_TOKEN_PREFIX + uuid
}

/** The UUID carried by a `@u|<uuid>` token, or null if not one. */
export function parseConstructionUuidId(idStr: string): string | null {
  return idStr.startsWith(UUID_TOKEN_PREFIX) ? idStr.slice(UUID_TOKEN_PREFIX.length) : null
}
