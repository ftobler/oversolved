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

export class AmbiguousQueryError extends Error {}

// ─── Typed queries ───

export interface LocalQuery {
  kind: "local"
  eid: string
  sub: string
}
export interface AbsoluteQuery {
  kind: "absolute"
  featureId: string
  eid: string
  sub: string
}
export interface AncestryQuery {
  kind: "ancestry"
  ancestorIds: string[]
  typeRestriction: string | null
}
export type QueryType = LocalQuery | AbsoluteQuery | AncestryQuery

export function local(eid: string, sub = ""): LocalQuery {
  return { kind: "local", eid, sub }
}
export function absolute(featureId: string, eid = "", sub = ""): AbsoluteQuery {
  return { kind: "absolute", featureId, eid, sub }
}
export function ancestry(
  ids: (QueryType | string)[],
  typeRestriction: string | null = null,
): AncestryQuery {
  const wireIds = ids.map(i => (typeof i === "string" ? i : emitWire(i)))
  return { kind: "ancestry", ancestorIds: wireIds, typeRestriction }
}

function isAlpha(ch: string): boolean {
  return /[A-Za-z]/.test(ch)
}

function localFromString(s: string): LocalQuery {
  const body = s.slice(1)
  for (const pt of ["start", "end", "center", "xy"]) {
    if (body.endsWith(pt) && body.length > pt.length) {
      const rest = body.slice(0, body.length - pt.length)
      if (rest && !isAlpha(rest[rest.length - 1])) {
        return { kind: "local", eid: rest, sub: pt }
      }
    }
  }
  return { kind: "local", eid: body, sub: "" }
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
    case "local":
      return "$" + q.eid + q.sub
    case "absolute":
      if (q.eid) return "@" + q.featureId + "/" + q.eid + (q.sub ? "/" + q.sub : "")
      return "@" + q.featureId
    case "ancestry": {
      const lengths = q.ancestorIds.map(i => i.length.toString(16)).join(",")
      let body = "?" + lengths + ";" + q.ancestorIds.join("")
      if (q.typeRestriction) body += ":" + q.typeRestriction
      return body
    }
  }
}

function parseAbsolute(s: string): AbsoluteQuery {
  const body = s.slice(1)
  const parts = body.split("/")
  if (parts.length === 1) return { kind: "absolute", featureId: parts[0], eid: "", sub: "" }
  if (parts.length === 2) return { kind: "absolute", featureId: parts[0], eid: parts[1], sub: "" }
  if (parts.length === 3) {
    return { kind: "absolute", featureId: parts[0], eid: parts[1], sub: parts[2] }
  }
  throw new Error(`Unrecognized absolute query format: ${JSON.stringify(s)}`)
}

function parseAncestryObj(s: string): AncestryQuery {
  const [ids, typeRestriction] = parseAncestry(s)
  return { kind: "ancestry", ancestorIds: ids, typeRestriction: typeRestriction || null }
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

/** Parse `?A,B;<idA><idB>` or `...:<TYPE>`. Returns [ids, typeRestriction|null]. */
export function parseAncestry(queryStr: string): [string[], string | null] {
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
  let pos = 0
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]
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
  if (pos < rest.length && rest[pos] === ":") {
    typeRestriction = rest.slice(pos + 1)
  }
  return [ids, typeRestriction]
}

/** Build an ancestry query string from a list of id strings. */
export function makeAncestryQuery(ids: string[], typeRestriction: string | null = null): string {
  const lengths = ids.map(i => i.length.toString(16)).join(",")
  let s = "?" + lengths + ";" + ids.join("")
  if (typeRestriction !== null && typeRestriction !== undefined) s += ":" + typeRestriction
  return s
}

// ─── Type hierarchy ───

const TYPE_HIERARCHY: Record<string, string[]> = {
  solid: [],
  face: [],
  flatface: ["face"],
  cylinderface: ["face"],
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

/** Attempt to coerce element to targetType using bodyStore and repoElements. */
function coerceType(
  element: unknown,
  targetType: string,
  bodyStore: Record<string, unknown> | null,
  repoElements: Map<string, unknown>,
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
  // Upward: child -> solid
  if (targetType === "solid" && bodyStore !== null) {
    return bodyStore[bodyId as string] ?? null
  }
  // Downward / sibling: scope to the same feature to avoid cross-feature collisions
  for (const el of repoElements.values()) {
    const elType = objType(el)
    if (
      isDict(el) &&
      el["body_id"] === bodyId &&
      el["created_by"] === createdBy &&
      (elType === targetType || isSubtype(elType, targetType))
    ) {
      return el
    }
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

/** Set the solve-loop current feature (mirrors the Python contextvar). */
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
  return [...new Set(ids)].sort().join(" ")
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  for (const x of small) if (!big.has(x)) return false
  return true
}

let _idCounter = 0
function genId(): string {
  return "el_" + (_idCounter++).toString(36)
}

export class Repository {
  elements = new Map<string, unknown>()
  ancestral = new Map<string, AncestralEntry>()
  byUuid = new Map<string, string[]>()
  featureIndex = new Map<string, number>()

  setFeatureOrder(featureOrder: string[]): void {
    this.featureIndex = new Map(featureOrder.map((fid, i) => [fid, i]))
  }

  private pruneUuid(): void {
    for (const [u, eids] of [...this.byUuid]) {
      if (!eids.some(eid => this.elements.has(eid))) this.byUuid.delete(u)
    }
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
    }
    entry.eids.push(id)
    this.elements.set(id, obj)
    if (uuid !== null) {
      const list = this.byUuid.get(uuid) ?? []
      list.push(id)
      this.byUuid.set(uuid, list)
    }
    return id
  }

  clearBySketchId(sketchId: string): void {
    for (const [k, v] of [...this.elements]) {
      if (isDict(v) && v["sketch_id"] === sketchId) this.elements.delete(k)
    }
  }

  gc(activeFids: Set<string>): void {
    for (const [key, entry] of [...this.ancestral]) {
      const refs = new Set<string>()
      for (const tag of entry.set) if (tag.startsWith("@")) refs.add(tag.slice(1))
      if (refs.size === 0) continue // keep tagless entries (builtin planes)
      let intersects = false
      for (const r of refs) if (activeFids.has(r)) { intersects = true; break }
      if (!intersects) {
        for (const eid of entry.eids) this.elements.delete(eid)
        this.ancestral.delete(key)
      }
    }
    this.pruneUuid()
  }

  featureIdxOfElement(eid: string): number | null {
    return featureIdxOfElement(this, eid)
  }

  private orderFilter(currentFeatureId: string | null): (eids: string[]) => string[] {
    if (currentFeatureId === null) currentFeatureId = getCurrentFeatureId()
    let currentIdx: number | undefined
    if (currentFeatureId !== null && this.featureIndex.size > 0) {
      currentIdx = this.featureIndex.get(currentFeatureId)
    }
    if (currentIdx === undefined) return eids => eids
    const cap = currentIdx
    return eids => {
      const kept: string[] = []
      for (const eid of eids) {
        const ownerIdx = this.featureIdxOfElement(eid)
        if (ownerIdx === null || ownerIdx <= cap) kept.push(eid)
      }
      return kept
    }
  }

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
      return this.elements.get(context + queryStr.slice(1)) ?? null
    }
    if (start === "@") {
      return this.elements.get(queryStr.slice(1)) ?? null
    }
    if (start === "?") {
      const [ids, typeRestriction] = parseAncestry(queryStr)
      return this.resolveAncestryIds(ids, typeRestriction, bodyStore, currentFeatureId)
    }
    return null
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
        return this.elements.get(context + q.eid + q.sub) ?? null
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
    for (const tok of uuidIds) {
      const uuid = parseConstructionUuidId(tok)
      if (uuid === null) continue
      let hits = orderFilter((this.byUuid.get(uuid) ?? []).filter(eid => this.elements.has(eid)))
      if (typeRestriction !== null) {
        hits = hits.filter(eid => {
          const t = objType(this.elements.get(eid))
          return t === typeRestriction || isSubtype(t, typeRestriction)
        })
      }
      if (hits.length === 1) return this.elements.get(hits[0]) ?? null
      if (hits.length > 1) {
        throw new AmbiguousQueryError(
          `Construction UUID ${uuid} matched ${hits.length} elements (collision by construction)`,
        )
      }
    }

    let candidateIds: string[] = []
    let querySet = new Set<string>()
    if (nonHashIds.length) {
      querySet = new Set(nonHashIds)
      for (const entry of this.ancestral.values()) {
        if (isSubset(querySet, entry.set)) candidateIds.push(...entry.eids)
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
          const coerced = coerceType(element, typeRestriction, bodyStore, this.elements)
          if (coerced !== null && coerced !== undefined && !seen.has(coerced)) {
            seen.add(coerced)
            coercedResults.push(coerced)
          }
        }
        if (coercedResults.length === 1) return coercedResults[0]
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
      // Descriptor tier: vertex identity (@gdv|), pending vertex construction
      // UUID emission. Face/edge descriptors were removed in Stage 6.
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
        if (isSubset(entry.set, querySet)) partialCandidates.push(...entry.eids)
      }
      partialCandidates = orderFilter([...new Set(partialCandidates)])
      if (typeRestriction !== null) {
        partialCandidates = partialCandidates.filter(
          eid => objType(this.elements.get(eid)) === typeRestriction,
        )
      }
      if (partialCandidates.length === 1) return this.elements.get(partialCandidates[0]) ?? null
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
      }
    }

    if (!candidateIds.length) return null
    if (candidateIds.length > 1) {
      throw new AmbiguousQueryError(
        `Query matched ${candidateIds.length} elements: ${JSON.stringify(candidateIds)}`,
      )
    }
    return this.elements.get(candidateIds[0]) ?? null
  }

  /** All elements whose ancestor set is a superset of the query's IDs. */
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
      if (isSubset(querySet, entry.set)) candidateIds.push(...entry.eids)
    }
    candidateIds = orderFilter(candidateIds)
    if (typeRestriction !== null) {
      candidateIds = candidateIds.filter(eid => objType(this.elements.get(eid)) === typeRestriction)
    }
    return candidateIds.filter(eid => this.elements.has(eid)).map(eid => this.elements.get(eid))
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
      if (isSubset(querySet, entry.set)) candidateIds.push(...entry.eids)
    }
    candidateIds = orderFilter(candidateIds)
    if (q.typeRestriction !== null) {
      candidateIds = candidateIds.filter(eid => objType(this.elements.get(eid)) === q.typeRestriction)
    }
    return candidateIds.filter(eid => this.elements.has(eid)).map(eid => this.elements.get(eid))
  }
}

/** Return the build-order index of the element's owning feature.
 *  Returns null for built-in geometry with no owning feature. */
export function featureIdxOfElement(repo: Repository, eid: string): number | null {
  const el = repo.elements.get(eid)
  if (!isDict(el)) return null
  const owner = (el["created_by"] as string) || (el["sketch_id"] as string)
  if (!owner) return null
  const idx = repo.featureIndex.get(owner)
  return idx === undefined ? null : idx
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
    for (const [k, entry] of [...repo.ancestral]) {
      if (entry.set.has(indexTag) && k !== key) {
        for (const eid of entry.eids) repo.elements.delete(eid)
        repo.ancestral.delete(k)
      }
    }
  }

  const exact = repo.ancestral.get(key)
  if (exact) {
    for (const eid of exact.eids) repo.elements.delete(eid)
    repo.ancestral.delete(key)
  }

  for (const [u, eids] of [...repo.byUuid]) {
    if (!eids.some(eid => repo.elements.has(eid))) repo.byUuid.delete(u)
  }

  return repo.registerAncestor(ancestorIds, payload, uuid)
}

// ─── Plane/point helpers (port of solver_plane) ───

interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Query-result -> 3D point (mirrors `_get_point_3d`). */
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
