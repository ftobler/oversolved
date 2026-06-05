// Port of oversolved/kernel/query.py. The element-geometry query engine:
// typed Query parsing/emission plus the live ancestry resolver (Repository).
//
// frozenset semantics: Python keys `ancestral` by a frozenset of ancestor ids
// and tests subset/superset containment hot in the drag loop. JS Set is not a
// value type and cannot be a Map key, so each entry stores both the Set (for
// containment) and a canonical sorted-join string (the Map key, deduping
// permutations exactly as frozenset does). See queryHeuristics.ts for scoring.

import {
  Outcome,
  DEFAULT_HEURISTIC_CONFIG,
  scoreOverlap,
  pickBest,
} from "./queryHeuristics"
import type { HeuristicConfig } from "./queryHeuristics"
import { BUILTIN_PLANES } from "./solverConstants"

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

function canonical(ids: Iterable<string>): string {
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
  // canonical frozenset key -> entry (preserves insertion order, like dict)
  ancestral = new Map<string, AncestralEntry>()
  byGeomHash = new Map<string, string[]>()
  featureIndex = new Map<string, number>()

  setFeatureOrder(featureOrder: string[]): void {
    this.featureIndex = new Map(featureOrder.map((fid, i) => [fid, i]))
  }

  private pruneGeomHash(): void {
    for (const [h, eids] of [...this.byGeomHash]) {
      if (!eids.some(eid => this.elements.has(eid))) this.byGeomHash.delete(h)
    }
  }

  register(elementId: string, obj: unknown): void {
    this.elements.set(elementId, obj)
  }

  registerAncestor(ancestors: string[], obj: unknown, geomHash: string | null = null): string {
    const id = genId()
    const key = canonical(ancestors)
    let entry = this.ancestral.get(key)
    if (!entry) {
      entry = { set: new Set(ancestors), eids: [] }
      this.ancestral.set(key, entry)
    }
    entry.eids.push(id)
    this.elements.set(id, obj)
    if (geomHash !== null) {
      const list = this.byGeomHash.get(geomHash) ?? []
      list.push(id)
      this.byGeomHash.set(geomHash, list)
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
    this.pruneGeomHash()
  }

  private featureIdxOfElement(eid: string): number | null {
    const el = this.elements.get(eid)
    if (!isDict(el)) return null
    const owner = (el["created_by"] as string) || (el["sketch_id"] as string)
    if (!owner) return null
    const idx = this.featureIndex.get(owner)
    return idx === undefined ? null : idx
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

    const hashIds = ids.filter(isGeomHashId)
    const classifierIds = ids.filter(isClassifierId)
    const nonHashIds = ids.filter(i => !isGeomHashId(i) && !isClassifierId(i))

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
        // Collect every distinct coercion result; >1 distinct is ambiguous and
        // must fail loud (fail-safe over fail-wrong). Same-object coercions
        // (several faces -> one solid) dedupe to a single clean result.
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
      // Stable tier BEFORE the geom hash: narrow ancestral siblings by spatial
      // role. Graceful: applied only when it leaves a non-empty set.
      const wanted = new Set(classifierIds.map(c => c.slice(1)))
      const narrowed = candidateIds.filter(eid => {
        const el = this.elements.get(eid)
        const cls = new Set((isDict(el) ? (el["classifiers"] as string[]) : null) ?? [])
        return isSubset(wanted, cls)
      })
      if (narrowed.length) candidateIds = narrowed
    }

    if (candidateIds.length > 1 && hashIds.length) {
      // Tie-break by geometry hash in specificity order: precise element hash
      // first, then the @gnormal_ orientation-only fallback, staying within the
      // ancestry-matched set so @gnormal_ never reaches across lineages.
      const preciseHashes = hashIds.filter(h => !h.startsWith("@gnormal_")).map(h => h.slice(1))
      const normalHashes = hashIds.filter(h => h.startsWith("@gnormal_")).map(h => h.slice(1))
      for (const tier of [preciseHashes, normalHashes]) {
        if (candidateIds.length <= 1) break
        for (const geomHashStr of tier) {
          const hashSet = new Set(
            (this.byGeomHash.get(geomHashStr) ?? []).filter(eid => this.elements.has(eid)),
          )
          const narrowed = candidateIds.filter(eid => hashSet.has(eid))
          if (narrowed.length) candidateIds = narrowed
        }
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

    if (!candidateIds.length && hashIds.length) {
      // No ancestry matched: resolve by the precise hash only. The @gnormal_
      // fallback is skipped here (without an ancestry bound it would match
      // across unrelated lineages).
      const preciseHashes = hashIds.filter(h => !h.startsWith("@gnormal_")).map(h => h.slice(1))
      const geomHashStr = preciseHashes.length ? preciseHashes[0] : hashIds[0].slice(1)
      let fallbackIds = (this.byGeomHash.get(geomHashStr) ?? []).filter(eid => this.elements.has(eid))
      if (typeRestriction !== null) {
        fallbackIds = fallbackIds.filter(eid => objType(this.elements.get(eid)) === typeRestriction)
      }
      candidateIds = orderFilter(fallbackIds)
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
    const querySet = new Set(ids.filter(i => !isGeomHashId(i) && !isClassifierId(i)))
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
    const querySet = new Set(q.ancestorIds.filter(i => !isGeomHashId(i) && !isClassifierId(i)))
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
  geomHash: string | null = null,
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

  // prune stale geom-hash entries (matches Python _prune_geom_hash)
  for (const [h, eids] of [...repo.byGeomHash]) {
    if (!eids.some(eid => repo.elements.has(eid))) repo.byGeomHash.delete(h)
  }

  return repo.registerAncestor(ancestorIds, payload, geomHash)
}

// Unwired Option B staging: recursive lineage nodes (kept for parity with the
// Python module; not on the live resolve path).

export interface QueryNode {
  id: string
  parents: QueryNode[]
  leafGeom: Record<string, unknown> | null
}

export function tagSet(node: QueryNode): Set<string> {
  const tags = new Set<string>([node.id])
  for (const p of node.parents) for (const t of tagSet(p)) tags.add(t)
  return tags
}

export function buildQuery(elementId: string, parentMap: Record<string, string[]>): QueryNode {
  const pid = elementId.startsWith("@") ? elementId : ref(elementId)
  const parents = parentMap[elementId] ?? []
  return { id: pid, parents: parents.map(p => buildQuery(p, parentMap)), leafGeom: null }
}

export function resolveQuery(
  node: QueryNode,
  repo: Repository,
  cfg: HeuristicConfig = DEFAULT_HEURISTIC_CONFIG,
): [Outcome, unknown] {
  const tags = tagSet(node)
  if (tags.size === 0) return [Outcome.UNRESOLVED, null]

  const exactHits: string[] = []
  for (const entry of repo.ancestral.values()) {
    if (isSubset(tags, entry.set)) exactHits.push(...entry.eids)
  }
  if (exactHits.length) {
    const unique = [...new Set(exactHits)]
    if (unique.length === 1) return [Outcome.RESOLVED, repo.elements.get(unique[0]) ?? null]
    const scores: [unknown, number][] = []
    for (const eid of unique) {
      let elemTags = new Set<string>()
      for (const entry of repo.ancestral.values()) {
        if (entry.eids.includes(eid)) {
          elemTags = entry.set
          break
        }
      }
      scores.push([repo.elements.get(eid) ?? null, scoreOverlap(tags, elemTags)])
    }
    return pickBest(scores, cfg)
  }

  const allScores: [unknown, number][] = []
  for (const entry of repo.ancestral.values()) {
    const overlap = scoreOverlap(tags, entry.set)
    if (overlap < cfg.overlapThreshold) continue
    for (const eid of entry.eids) allScores.push([repo.elements.get(eid) ?? null, overlap])
  }
  return pickBest(allScores, cfg)
}
