// The element-geometry query engine: typed Query parsing/emission plus the live ancestry
// resolver (Repository).
//
// frozenset semantics: Python keys `ancestral` by a frozenset of ancestor ids and tests
// subset/superset containment hot in the drag loop. JS Set is not a value type and cannot be a
// Map key, so each entry stores both the Set (for containment) and a canonical sorted-join
// string (the Map key, deduping permutations exactly as frozenset does). See queryHeuristics.ts
// for scoring.

import {
  BUILTIN_PLANES,
  FRONT_PLANE,
  isPlaneType,
  resolveBarePlaneId,
} from "./solverConstants"
import {
  DEFAULT_DESCRIPTOR_MATCH,
  descriptorDistance,
  descriptorOfElement,
  isGeomDescriptorId,
  narrowByDescriptor,
  parseGeomDescriptorId,
  type GeomDescriptor,
} from "./geomDescriptor"
import { failLoud } from "@/stores/stateInvariants"
import { VERTEX_POINT_KEYS } from "@/types/vertexKeys"
import type { LocalQuery, AbsoluteQuery, AncestryQuery, Query } from "@/types/query"

export type { LocalQuery, AbsoluteQuery, AncestryQuery, Query as QueryType } from "@/types/query"

/** Local alias for the canonical Query union (re-exported as QueryType). */
type QueryType = Query

export class AmbiguousQueryError extends Error {}

/** Surface a wire-format ambiguity in dev/test only. Minted base64url entity
 *  ids routinely end in a vertex-key word (a bare id ending in "xy" or "start"
 *  is a real, frequently-minted shape), and the kernel parser cannot see the
 *  entity-id set, so a loud failure here would break production writes. The
 *  knownIds readers (resolveLocal / resolveQueryRef) are the resolver for these
 *  strings; emitWire just warns so the ambiguity is never silently hidden. */
const warnWireAmbiguity = import.meta.env?.DEV || import.meta.env?.MODE === "test"
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

function localFromString(s: string): LocalQuery {
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
function localKeyFor(context: string, q: LocalQuery): string {
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
    case "absolute":
      if (q.eid) return "@" + q.featureId + "/" + q.eid + (q.sub ? "/" + q.sub : "")
      return "@" + q.featureId
    case "ancestry": {
      // An empty id is un-frameable: "?0;" reads back as zero ids, so emitting
      // one would silently lose it.
      if (q.ancestorIds.some(id => id.length === 0)) {
        throw new Error(`ancestry query cannot frame an empty id: ${JSON.stringify(q.ancestorIds)}`)
      }
      // An empty id list is framed as "?0;" (the parseable canonical form;
      // "?;" has an empty length header that parseAncestry rejects).
      const lengths = q.ancestorIds.length ? q.ancestorIds.map(i => i.length.toString(16)).join(",") : "0"
      let body = "?" + lengths + ";" + q.ancestorIds.join("")
      // An empty type restriction is null on the wire: never emit a trailing ":".
      if (q.typeRestriction) body += ":" + q.typeRestriction
      if (q.classifier) body += "@" + q.classifier
      return body
    }
  }
}

function parseAbsolute(s: string): AbsoluteQuery {
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

const BODY_AT_RE = /@(body_[^@:;,]+)/g

/** Return the body id ("body_...") a query refers to, or null. */
export function bodyIdOf(queryStr: string, bodyStore?: Record<string, unknown> | null): string | null {
  const candidates: string[] = []
  let m: RegExpExecArray | null
  BODY_AT_RE.lastIndex = 0
  while ((m = BODY_AT_RE.exec(queryStr)) !== null) candidates.push(m[1])
  if (bodyStore != null) {
    for (const c of candidates) if (c in bodyStore) return c
  }
  return candidates.length ? candidates[0] : null
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
  // An empty type restriction is null on the wire: never emit a trailing ":".
  if (typeRestriction) s += ":" + typeRestriction
  if (classifier) s += "@" + classifier
  return s
}

// ─── Type hierarchy ───

const TYPE_HIERARCHY: Record<string, string[]> = {
  solid: [],
  face: [],
  flatface: ["face"],
  cylinderface: ["face"],
  coneface: ["face"],
  sphereface: ["face"],
  torusface: ["face"],
  edge: [],
  straightedge: ["edge"],
  vertex: [],
}

function isSubtype(actualType: string | null, targetType: string): boolean {
  if (actualType === null) return false
  if (actualType === targetType) return true
  return (TYPE_HIERARCHY[actualType] ?? []).includes(targetType)
}

function objType(obj: unknown): string | null {
  if (obj !== null && typeof obj === "object") {
    const t = (obj as Record<string, unknown>)["type"]
    return typeof t === "string" ? t : null
  }
  return null
}

function isDict(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj)
}

/** The body's `modified_by` feature chain from the store, or null when absent. */
function bodyModifiersOf(
  bodyStore: Record<string, unknown> | null,
  bodyId: unknown,
): string[] | null {
  if (bodyStore === null) return null
  const body = bodyStore[bodyId as string]
  if (!isDict(body)) return null
  const mods = body["modified_by"]
  return Array.isArray(mods) ? (mods as string[]) : null
}

/** Attempt to coerce element to targetType using bodyStore and the repository. */
function coerceType(
  element: unknown,
  targetType: string,
  bodyStore: Record<string, unknown> | null,
  repo: Repository,
  queryIds: ReadonlySet<string>,
): unknown {
  if (element === null || element === undefined) return null
  const ot = objType(element)
  if (ot === null) return null
  if (ot === targetType || isSubtype(ot, targetType)) return element
  if (!isDict(element)) return null
  const bodyId = element["body_id"]
  if (bodyId === null || bodyId === undefined) return null
  const createdBy = element["created_by"]
  if (createdBy === null || createdBy === undefined) return null
  // Upward: child -> solid. The store is the only source of the solid; every
  // solve-time call site threads it, so a null/empty store is a wiring bug and
  // fails loud in dev/test instead of silently returning null.
  if (targetType === "solid") {
    if (bodyStore === null || Object.keys(bodyStore).length === 0) {
      failLoud(
        `coerceType: upward :solid coercion requested with no body store ` +
          `(body ${JSON.stringify(bodyId)})`,
      )
      return null
    }
    return bodyStore[bodyId as string] ?? null
  }
  // Downward / sibling: scope to the query's ancestry so a coerced sibling is
  // provably in the query's lineage. Only entries sharing a nonHash query token
  // are reachable through byAncestorId, so no element outside the lineage is
  // even examined. A body's modified_by chain admits a sibling created by a
  // different feature (a fillet-created face coerces to a same-body edge the
  // original feature made).
  const matches: unknown[] = []
  const seen = new Set<unknown>()
  const bodyMods = bodyModifiersOf(bodyStore, bodyId)
  const keys = new Set<string>()
  for (const qid of queryIds) {
    const tagged = repo.byAncestorId.get(qid)
    if (tagged) for (const k of tagged) keys.add(k)
  }
  for (const key of keys) {
    const entry = repo.ancestral.get(key)
    if (entry === undefined) continue
    for (const eid of entry.eids) {
      const el = repo.elements.get(eid)
      if (el === undefined || el === element) continue
      if (!isDict(el)) continue
      if (el["body_id"] !== bodyId) continue
      const elType = objType(el)
      if (!(elType === targetType || isSubtype(elType, targetType))) continue
      const elCreatedBy = el["created_by"]
      if (typeof elCreatedBy !== "string") continue
      if (elCreatedBy !== createdBy && !(bodyMods !== null && bodyMods.includes(elCreatedBy))) {
        continue
      }
      if (!seen.has(el)) {
        seen.add(el)
        matches.push(el)
      }
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new AmbiguousQueryError(
      `Query coerced to ${matches.length} distinct '${targetType}' elements ` +
        `in body ${JSON.stringify(bodyId)}`,
    )
  }
  return null
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

// ─── Solve-loop ordering guard (contextvar equivalent) ───

let _currentFeatureId: string | null = null

/** Set the solve-loop current feature. */
export function setCurrentFeatureId(fid: string | null): void {
  _currentFeatureId = fid
}
export function getCurrentFeatureId(): string | null {
  return _currentFeatureId
}

// ─── Repository ───

interface AncestralEntry {
  set: Set<string>
  eids: string[]
}

/** Canonical frozenset key: dedup + sort + join (value-equal across permutations). */
export function canonical(ids: Iterable<string>): string {
  return [...new Set(ids)].sort().join("\u0000")
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  for (const x of small) if (!big.has(x)) return false
  return true
}

let _idCounter = 0
function genId(): string {
  return "el_" + (_idCounter++).toString(36)
}

/** Which resolution tier answered the last ancestry query. Diagnostic only:
 *  corpus tests assert the tier so a query silently falling back from UUID to
 *  a weaker tier is caught, not masked. Not persisted, not part of any result. */
export type ResolveTier =
  | "uuid"           // primary: construction UUID exact match
  | "ancestral"      // ancestor-set subset match (optionally classifier/descriptor narrowed)
  | "ancestral-partial"  // relaxed superset fallback when the subset match was empty
  | "descriptor"     // legacy-only: @gd*| geometry-descriptor fallback for queries
                     // saved before faces/edges/vertices earned UUIDs; current
                     // producers emit no descriptor tokens
  | "miss"           // nothing resolved

export class Repository {
  elements = new Map<string, unknown>()
  ancestral = new Map<string, AncestralEntry>()
  byUuid = new Map<string, string[]>()
  /** Reverse index: ancestor id -> the ancestral keys whose entry.set contains it.
   *  Turns index-tag eviction from a full scan of `ancestral` into a lookup. Every
   *  ancestor id is indexed, not just tag-shaped ones, because eviction tests plain
   *  set membership. Derived state: never persisted (see `snapshotRepo`), rebuilt by
   *  `rebuildIndices()` whenever `ancestral` is assigned wholesale instead of mutated. */
  byAncestorId = new Map<string, Set<string>>()
  /** eid -> the uuid it was registered under (at most one, by construction), so
   *  deleting an element can re-check that single `byUuid` bucket. */
  elementUuid = new Map<string, string>()
  /** uuids whose bucket may have lost its last live element. Drained at exactly the
   *  points the old full `byUuid` sweep ran, so pruning stays observably identical. */
  private _dirtyUuids = new Set<string>()
  featureIndex = new Map<string, number>()
  _lastTier: ResolveTier = "miss"

  setFeatureOrder(featureOrder: string[]): void {
    this.featureIndex = new Map(featureOrder.map((fid, i) => [fid, i]))
  }

  private pruneUuid(): void {
    for (const [u, eids] of [...this.byUuid]) {
      if (!eids.some(eid => this.elements.has(eid))) this.byUuid.delete(u)
    }
    this._dirtyUuids.clear()
  }

  // Prune only the uuid buckets touched since the last drain.
  prunePendingUuids(): void {
    for (const u of this._dirtyUuids) {
      const eids = this.byUuid.get(u)
      if (eids && !eids.some(eid => this.elements.has(eid))) this.byUuid.delete(u)
    }
    this._dirtyUuids.clear()
  }

  /** Recompute `byAncestorId` / `elementUuid` from `ancestral` / `byUuid`. Required
   *  after assigning those maps wholesale (`repoFromSnapshot`). Every loaded uuid is
   *  marked pending: a snapshot may carry a bucket that is already fully dead, which
   *  the old full sweep would have collected on the next eviction. */
  rebuildIndices(): void {
    this.byAncestorId = new Map()
    for (const [key, entry] of this.ancestral) this.indexAncestral(key, entry)
    this.elementUuid = new Map()
    this._dirtyUuids = new Set()
    for (const [uuid, eids] of this.byUuid) {
      // Live elements only, so `elementUuid` stays exactly "live eid -> its uuid"
      // and a missed `deleteElement` is detectable. A snapshot's byUuid list can
      // carry eids that were already dead when it was written; those need no
      // future prune trigger, and the seeding below covers their bucket anyway.
      for (const eid of eids) if (this.elements.has(eid)) this.elementUuid.set(eid, uuid)
      this._dirtyUuids.add(uuid)
    }
  }

  private indexAncestral(key: string, entry: AncestralEntry): void {
    for (const id of entry.set) {
      let keys = this.byAncestorId.get(id)
      if (!keys) {
        keys = new Set()
        this.byAncestorId.set(id, keys)
      }
      keys.add(key)
    }
  }

  /** The entry's element ids that are still registered. Dangling eids are a
   *  supported state (clearBySketchId deletes elements without pruning the
   *  index), so every scan that feeds a resolve/ambiguity decision must filter
   *  by liveness or dead ids count toward ambiguity and can even win. */
  private liveEntryEids(entry: AncestralEntry): string[] {
    return entry.eids.filter(eid => this.elements.has(eid))
  }

  /** Drop an ancestral entry, keeping `byAncestorId` in step. Does not touch the
   *  entry's elements: callers decide whether those die with it. */
  deleteAncestral(key: string): void {
    const entry = this.ancestral.get(key)
    if (entry === undefined) return
    this.ancestral.delete(key)
    for (const id of entry.set) {
      const keys = this.byAncestorId.get(id)
      if (keys === undefined) continue
      keys.delete(key)
      if (keys.size === 0) this.byAncestorId.delete(id)
    }
  }

  /** Drop an element and flag its uuid bucket for re-check. Every element deletion
   *  must go through here, or a dead uuid bucket survives into the snapshot. */
  deleteElement(eid: string): void {
    this.elements.delete(eid)
    const uuid = this.elementUuid.get(eid)
    if (uuid === undefined) return
    this.elementUuid.delete(eid)
    this._dirtyUuids.add(uuid)
  }

  register(elementId: string, obj: unknown): void {
    this.elements.set(elementId, obj)
  }

  registerAncestor(
    ancestors: string[],
    obj: unknown,
    uuid: string | null = null,
  ): string {
    const id = genId()
    const key = canonical(ancestors)
    let entry = this.ancestral.get(key)
    if (!entry) {
      entry = { set: new Set(ancestors), eids: [] }
      this.ancestral.set(key, entry)
      this.indexAncestral(key, entry)
    }
    entry.eids.push(id)
    this.elements.set(id, obj)
    if (uuid !== null) {
      const list = this.byUuid.get(uuid) ?? []
      list.push(id)
      this.byUuid.set(uuid, list)
      this.elementUuid.set(id, uuid)
    }
    return id
  }

  clearBySketchId(sketchId: string): void {
    for (const [k, v] of [...this.elements]) {
      if (isDict(v) && v["sketch_id"] === sketchId) this.deleteElement(k)
    }
  }

  gc(activeFids: Set<string>): void {
    for (const [key, entry] of [...this.ancestral]) {
      const refs = new Set<string>()
      for (const tag of entry.set) if (tag.startsWith("@")) refs.add(tag.slice(1))
      if (refs.size === 0) continue  // keep tagless entries (builtin planes)
      let intersects = false
      for (const r of refs) if (activeFids.has(r)) { intersects = true; break }
      if (!intersects) {
        for (const eid of entry.eids) this.deleteElement(eid)
        this.deleteAncestral(key)
      }
    }
    this.pruneUuid()
  }

  private orderFilter(currentFeatureId: string | null): (eids: string[]) => string[] {
    if (currentFeatureId === null) currentFeatureId = getCurrentFeatureId()
    if (currentFeatureId === null || this.featureIndex.size === 0) return eids => eids
    const currentIdx = this.featureIndex.get(currentFeatureId)
    if (currentIdx === undefined) {
      failLoud(
        `query: currentFeatureId ${JSON.stringify(currentFeatureId)} is not in the ` +
          `feature order; the ordering guard falls back to identity filtering`,
      )
      return eids => eids
    }
    const cap = currentIdx
    return eids => {
      const kept: string[] = []
      for (const eid of eids) {
        const owner = ownerStateOfElement(this, eid)
        if (owner.kind === "builtin" || (owner.kind === "indexed" && owner.idx <= cap)) {
          kept.push(eid)
        }
      }
      return kept
    }
  }

  /** Resolve a query against the repo.
   *
   *  Context contract: `context` applies to `$` local queries only and must be
   *  null or end in "/". The element key is `context + eid` for a bare local
   *  and `context + eid + "/" + sub` for a sub-point, matching the
   *  `featureId/eid/sub` slash registration from postRegister. A non-slash
   *  context is a programming error and fails loud in dev/test. Every
   *  production caller passes null today.
   *
   *  Ordering guard: when `currentFeatureId` is set (or the solve-loop
   *  contextvar is active), ancestry resolution refuses elements whose owning
   *  feature comes after the current feature in the build order, plus elements
   *  whose owner is no longer in the order at all (orphaned). Built-ins with no
   *  owner field are always matchable. An unknown `currentFeatureId` fails loud
   *  in dev/test instead of silently disabling the guard. */
  query(
    queryStr: string | QueryType,
    context: string | null = null,
    bodyStore: Record<string, unknown> | null = null,
    currentFeatureId: string | null = null,
  ): unknown {
    if (typeof queryStr !== "string") {
      return this.queryTyped(queryStr, context, bodyStore, currentFeatureId)
    }
    if (!queryStr) return null
    const start = queryStr[0]
    if (start === "$") {
      if (context === null) return null
      this.assertLocalContext(context)
      return this.elements.get(localKeyFor(context, localFromString(queryStr))) ?? null
    }
    if (start === "@") {
      // Strict: route through parseAbsolute so the string and typed paths agree
      // on shape (a 4+ part or empty-part key is rejected loudly instead of a
      // lenient slice(1) lookup). The key is built exactly like queryTyped's
      // absolute case.
      const abs = parseAbsolute(queryStr)
      const key = abs.eid ? abs.featureId + "/" + abs.eid + (abs.sub ? "/" + abs.sub : "") : abs.featureId
      return this.elements.get(key) ?? null
    }
    if (start === "?") {
      const [ids, typeRestriction] = parseAncestry(queryStr)
      return this.resolveAncestryIds(ids, typeRestriction, bodyStore, currentFeatureId)
    }
    return null
  }

  private assertLocalContext(context: string): void {
    if (!context.endsWith("/")) {
      failLoud(
        `query: local context must end in "/" so the key is ` +
          `"context + eid[/sub]" (got ${JSON.stringify(context)})`,
      )
    }
  }

  private queryTyped(
    q: QueryType,
    context: string | null,
    bodyStore: Record<string, unknown> | null,
    currentFeatureId: string | null,
  ): unknown {
    switch (q.kind) {
      case "local":
        if (context === null) return null
        this.assertLocalContext(context)
        return this.elements.get(localKeyFor(context, q)) ?? null
      case "absolute": {
        const key = q.eid ? q.featureId + "/" + q.eid + (q.sub ? "/" + q.sub : "") : q.featureId
        return this.elements.get(key) ?? null
      }
      case "ancestry":
        return this.resolveAncestryIds(q.ancestorIds, q.typeRestriction, bodyStore, currentFeatureId)
    }
  }

  private resolveAncestryIds(
    ids: string[],
    typeRestriction: string | null,
    bodyStore: Record<string, unknown> | null = null,
    currentFeatureId: string | null = null,
  ): unknown {
    this._lastTier = "miss"
    const orderFilter = this.orderFilter(currentFeatureId)

    const classifierIds = ids.filter(isClassifierId)
    const descriptorIds = ids.filter(isGeomDescriptorId)
    const uuidIds = ids.filter(isConstructionUuidId)
    const nonHashIds = ids.filter(
      i =>
        !isGeomHashId(i) &&
        !isClassifierId(i) &&
        !isGeomDescriptorId(i) &&
        !isConstructionUuidId(i),
    )

    // Primary tier: construction UUID exact match.
    //
    // Fail-loud contract (uuid-tier-type-fallthrough): a query naming a live
    // construction UUID must resolve to the element that carries the uuid or
    // throw - it must never silently fall through to a weaker tier and resolve
    // a DIFFERENT element. Two guards make that hold:
    //   - the multiplicity check counts ALL live hits in the bucket BEFORE the
    //     type/order filters, so a genuine collision is never narrowed away;
    //   - when the type restriction excludes the live uuid element, the weaker
    //     tiers may only resolve nothing (the uuid-alone null case); a non-null
    //     weaker-tier resolution would be a silent swap and fails loud.
    const uuidTokens = [...new Set(
      uuidIds.map(parseConstructionUuidId).filter((u): u is string => u !== null),
    )]
    if (uuidTokens.length > 1) {
      throw new AmbiguousQueryError(
        `Query names ${uuidTokens.length} distinct construction UUIDs; refusing to silently pick one`,
      )
    }
    let uuidResolution: unknown = null
    let uuidTypeExcluded: string | null = null
    for (const uuid of uuidTokens) {
      const liveHits = (this.byUuid.get(uuid) ?? []).filter(eid => this.elements.has(eid))
      if (liveHits.length > 1) {
        throw new AmbiguousQueryError(
          `Construction UUID ${uuid} matched ${liveHits.length} live elements (collision by construction)`,
        )
      }
      if (liveHits.length === 0) continue  // no live element carries the uuid: weaker tiers may recover
      const eid = liveHits[0]
      if (orderFilter([eid]).length === 0) continue  // ordering guard: the element is not visible from here yet
      const element = this.elements.get(eid)
      if (typeRestriction !== null) {
        const t = objType(element)
        if (!(t === typeRestriction || isSubtype(t, typeRestriction))) {
          uuidTypeExcluded = uuid
          continue
        }
      }
      uuidResolution = element ?? null
    }
    if (uuidResolution !== null) {
      this._lastTier = "uuid"
      return uuidResolution
    }
    // Gate every non-null exit of the weaker tiers while a live uuid element
    // was excluded by the type restriction: such a result is a different
    // element that does not carry the named uuid.
    const refuseUuidSwap = (result: unknown): unknown => {
      if (uuidTypeExcluded !== null && result !== null) {
        throw new AmbiguousQueryError(
          `Construction UUID ${uuidTypeExcluded} resolves an element that is not of type ` +
            `'${typeRestriction}'; refusing to resolve a different element in its place`,
        )
      }
      return result
    }

    let candidateIds: string[] = []
    let descriptorFallback = false
    let querySet = new Set<string>()
    if (nonHashIds.length) {
      querySet = new Set(nonHashIds)
      for (const entry of this.ancestral.values()) {
        if (isSubset(querySet, entry.set)) candidateIds.push(...this.liveEntryEids(entry))
      }
    }
    candidateIds = orderFilter(candidateIds)

    if (typeRestriction !== null && candidateIds.length) {
      const exactMatches = candidateIds.filter(
        eid => objType(this.elements.get(eid)) === typeRestriction,
      )
      if (exactMatches.length) {
        candidateIds = exactMatches
      } else {
        const coercedResults: unknown[] = []
        const seen = new Set<unknown>()
        for (const eid of candidateIds) {
          const element = this.elements.get(eid)
          const coerced = coerceType(element, typeRestriction, bodyStore, this, querySet)
          if (coerced !== null && coerced !== undefined && !seen.has(coerced)) {
            seen.add(coerced)
            coercedResults.push(coerced)
          }
        }
        if (coercedResults.length === 1) { this._lastTier = "ancestral"; return refuseUuidSwap(coercedResults[0]) }
        if (coercedResults.length > 1) {
          throw new AmbiguousQueryError(
            `Query coerced to ${coercedResults.length} distinct '${typeRestriction}' elements`,
          )
        }
        candidateIds = []
      }
    }

    if (candidateIds.length > 1 && classifierIds.length) {
      const wanted = new Set(classifierIds.map(c => c.slice(1)))
      const narrowed = candidateIds.filter(eid => {
        const el = this.elements.get(eid)
        const cls = new Set((isDict(el) ? (el["classifiers"] as string[]) : null) ?? [])
        return isSubset(wanted, cls)
      })
      if (narrowed.length) candidateIds = narrowed
    }

    if (candidateIds.length > 1 && descriptorIds.length) {
      // Legacy descriptor tier: resolves @gd*| tokens in queries saved before
      // the producers stopped emitting them. Current code mints no descriptor
      // tokens, so this only fires for old persisted queries.
      for (const dTok of descriptorIds) {
        if (candidateIds.length <= 1) break
        const qd = parseGeomDescriptorId(dTok)
        if (qd === null) continue
        const pairs = candidateIds.map(
          eid => [eid, descriptorOfElement(this.elements.get(eid))] as [string, GeomDescriptor | null],
        )
        candidateIds = narrowByDescriptor(qd, pairs)
      }
    }

    if (!candidateIds.length && nonHashIds.length) {
      let partialCandidates: string[] = []
      for (const entry of this.ancestral.values()) {
        if (isSubset(entry.set, querySet)) partialCandidates.push(...this.liveEntryEids(entry))
      }
      partialCandidates = orderFilter([...new Set(partialCandidates)])
      if (typeRestriction !== null) {
        partialCandidates = partialCandidates.filter(
          eid => objType(this.elements.get(eid)) === typeRestriction,
        )
      }
      if (partialCandidates.length === 1) {
        this._lastTier = "ancestral-partial"
        return refuseUuidSwap(this.elements.get(partialCandidates[0]) ?? null)
      }
    }

    if (!candidateIds.length && descriptorIds.length) {
      // Descriptor-only fallback: without an ancestry bound, match TIGHT only.
      const qd = descriptorIds.map(parseGeomDescriptorId).find(d => d !== null) ?? null
      if (qd !== null) {
        const fallbackIds: string[] = []
        for (const [eid, el] of this.elements) {
          if (typeRestriction !== null && objType(el) !== typeRestriction) continue
          const cd = descriptorOfElement(el)
          if (cd === null) continue
          const dist = descriptorDistance(qd, cd)
          if (dist !== null && dist <= DEFAULT_DESCRIPTOR_MATCH.tightTol) fallbackIds.push(eid)
        }
        candidateIds = orderFilter(fallbackIds)
        if (candidateIds.length) descriptorFallback = true
      }
    }

    // Resolve can only happen on a live element: every scan above filters by
    // liveness, but re-check here so the tier label never claims a resolve
    // ("ancestral"/"descriptor") while returning null for a dead winner.
    candidateIds = candidateIds.filter(eid => this.elements.has(eid))

    if (!candidateIds.length) return null
    if (candidateIds.length > 1) {
      throw new AmbiguousQueryError(
        `Query matched ${candidateIds.length} elements: ${JSON.stringify(candidateIds)}`,
      )
    }
    this._lastTier = descriptorFallback ? "descriptor" : "ancestral"
    return refuseUuidSwap(this.elements.get(candidateIds[0]) ?? null)
  }

  // All elements whose ancestor set is a superset of the query's IDs.
  queryAll(queryStr: string, currentFeatureId: string | null = null): unknown[] {
    if (!queryStr || queryStr[0] !== "?") return []
    const orderFilter = this.orderFilter(currentFeatureId)
    const [ids, typeRestriction] = parseAncestry(queryStr)
    const querySet = new Set(
      ids.filter(
        i =>
          !isGeomHashId(i) &&
          !isClassifierId(i) &&
          !isGeomDescriptorId(i) &&
          !isConstructionUuidId(i),
      ),
    )
    let candidateIds: string[] = []
    for (const entry of this.ancestral.values()) {
      if (isSubset(querySet, entry.set)) candidateIds.push(...this.liveEntryEids(entry))
    }
    candidateIds = orderFilter(candidateIds)
    if (typeRestriction !== null) {
      candidateIds = candidateIds.filter(eid => objType(this.elements.get(eid)) === typeRestriction)
    }
    return candidateIds.map(eid => this.elements.get(eid))
  }

  queryAllTyped(q: AncestryQuery, currentFeatureId: string | null = null): unknown[] {
    const orderFilter = this.orderFilter(currentFeatureId)
    const querySet = new Set(
      q.ancestorIds.filter(
        i =>
          !isGeomHashId(i) &&
          !isClassifierId(i) &&
          !isGeomDescriptorId(i) &&
          !isConstructionUuidId(i),
      ),
    )
    let candidateIds: string[] = []
    for (const entry of this.ancestral.values()) {
      if (isSubset(querySet, entry.set)) candidateIds.push(...this.liveEntryEids(entry))
    }
    candidateIds = orderFilter(candidateIds)
    if (q.typeRestriction !== null) {
      candidateIds = candidateIds.filter(eid => objType(this.elements.get(eid)) === q.typeRestriction)
    }
    return candidateIds.map(eid => this.elements.get(eid))
  }
}

/** Return the build-order index of the element's owning feature, or null when
 *  the element has no owner or its owner is not in the current order. The
 *  ordering guard does not use this: it reads the tri-state directly so an
 *  orphaned owner is excluded instead of conflated with built-in. */
export function featureIdxOfElement(repo: Repository, eid: string): number | null {
  const state = ownerStateOfElement(repo, eid)
  return state.kind === "indexed" ? state.idx : null
}

type OwnerState =
  | { kind: "builtin" }
  | { kind: "orphaned" }
  | { kind: "indexed"; idx: number }

/** Tri-state owner lookup for the ordering guard. "builtin" (no owner field at
 *  all) is always matchable; "indexed" is compared against the current feature;
 *  "orphaned" (an owner field naming a feature no longer in the order) is
 *  excluded while the guard is active, since its build position is unknowable
 *  and the stale-geometry hazard is exactly this case. */
function ownerStateOfElement(repo: Repository, eid: string): OwnerState {
  const el = repo.elements.get(eid)
  if (!isDict(el)) return { kind: "builtin" }
  const owner = (el["created_by"] as string) || (el["sketch_id"] as string)
  if (!owner) return { kind: "builtin" }
  const idx = repo.featureIndex.get(owner)
  return idx === undefined ? { kind: "orphaned" } : { kind: "indexed", idx }
}

/** Create and populate the global repository with built-in planes and origin. */
export function initGlobalRepo(): Repository {
  const repo = new Repository()
  repo.register("builtin_origin", { external_xy: [0.0, 0.0] })
  for (const [name, plane] of Object.entries(BUILTIN_PLANES)) repo.register(name, plane)
  return repo
}

/** Evict stale ancestry entries and register a new one. */
export function evictAncestryAndRegister(
  repo: Repository,
  ancestorIds: string[],
  payload: Record<string, unknown>,
  indexTag: string | null = null,
  uuid: string | null = null,
): string {
  const key = canonical(ancestorIds)

  if (indexTag !== null) {
    // Only the entries actually carrying the tag, via the reverse index: scanning all
    // of `ancestral` here made a whole registration pass quadratic (288s on a 62k
    // entity STEP assembly). The spread is over the matched keys, not the repo.
    const tagged = repo.byAncestorId.get(indexTag)
    if (tagged) {
      for (const k of [...tagged]) {
        if (k === key) continue
        const entry = repo.ancestral.get(k)
        if (entry === undefined) {
          tagged.delete(k)  // index rot: self-heal rather than let the dangling key persist
          continue
        }
        for (const eid of entry.eids) repo.deleteElement(eid)
        repo.deleteAncestral(k)
      }
    }
  }

  const exact = repo.ancestral.get(key)
  if (exact) {
    for (const eid of exact.eids) repo.deleteElement(eid)
    repo.deleteAncestral(key)
  }

  repo.prunePendingUuids()

  return repo.registerAncestor(ancestorIds, payload, uuid)
}

/** Evict every ancestral entry whose set carries `@bodyId` - a body's whole
 *  face/edge/vertex index range at once - and prune the uuid buckets their
 *  elements left behind. Body-scoped via the reverse index (O(entries sharing
 *  the tag), not O(repo)), the same lookup `evictAncestryAndRegister` uses for
 *  its index-tag spread. Call before re-registering a body's range so a
 *  shrunken range replaces the old one wholesale instead of leaving indices
 *  k..N-1 resolvable forever; delete_body routes through it too. */
export function clearBodyAncestry(repo: Repository, bodyId: string): void {
  const tagged = repo.byAncestorId.get('@' + bodyId)
  if (!tagged) return
  for (const key of [...tagged]) {
    const entry = repo.ancestral.get(key)
    if (entry === undefined) {
      tagged.delete(key)  // index rot: self-heal rather than let the dangling key persist
      continue
    }
    for (const eid of entry.eids) repo.deleteElement(eid)
    repo.deleteAncestral(key)
  }
  repo.prunePendingUuids()
}

// ─── Plane/point helpers ───

interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Query-result -> 3D point. */
export function getPoint3d(ref: Record<string, unknown>, globalRepo: Repository): number[] {
  if ("external_xy" in ref) {
    const xy = ref["external_xy"] as number[]
    const sketchId = ref["sketch_id"] as string | undefined
    if (sketchId) {
      const pt = globalRepo.elements.get("_pt_" + sketchId) as PlaneLike | undefined
      if (pt) {
        return [
          pt.origin[0] + xy[0] * pt.x_axis[0] + xy[1] * pt.y_axis[0],
          pt.origin[1] + xy[0] * pt.x_axis[1] + xy[1] * pt.y_axis[1],
          pt.origin[2] + xy[0] * pt.x_axis[2] + xy[1] * pt.y_axis[2],
        ]
      }
    }
    return [xy[0], xy[1], 0.0]
  }
  if (ref["type"] === "vertex" && "origin" in ref) return ref["origin"] as number[]
  if ("origin" in ref && !("normal" in ref)) return ref["origin"] as number[]
  if ("origin" in ref && "normal" in ref) throw new Error("reference is a plane, not a point")
  throw new Error("point reference has no coordinates")
}

/** Resolve a plane query string (e.g. "$f1", "@builtin_plane_right", "Front")
 *  to a plane dict. Falls back to FRONT_PLANE on unresolvable input. */
export function resolvePlaneEarly(
  planeQuery: string | null,
  globalRepo: Repository | null,
): Record<string, unknown> {
  if (!planeQuery) throw new Error("sketch has no plane assignment")

  const bareName = resolveBarePlaneId(planeQuery)
  if (bareName) return BUILTIN_PLANES[bareName] as Record<string, unknown>

  if (planeQuery.startsWith("@")) {
    const builtin = BUILTIN_PLANES[planeQuery.slice(1)]
    if (builtin) return builtin as Record<string, unknown>
    if (globalRepo !== null) {
      const p = globalRepo.elements.get(planeQuery.slice(1))
      if (isDict(p) && isPlaneType(p)) return p
    }
    return FRONT_PLANE as Record<string, unknown>
  }

  if (planeQuery.startsWith("$") && globalRepo !== null) {
    const p = globalRepo.elements.get(planeQuery.slice(1))
    if (isDict(p)) {
      if (isPlaneType(p)) return p
    }
    return FRONT_PLANE as Record<string, unknown>
  }

  return FRONT_PLANE as Record<string, unknown>
}
