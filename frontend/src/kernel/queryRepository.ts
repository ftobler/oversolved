// The live ancestry repository: frozenset-keyed registration, the tiered query
// resolver, coercion, gc and the body-scoped eviction helpers. Split out of
// query.ts; the query.ts barrel re-exports the public surface unchanged.

import {
  DEFAULT_DESCRIPTOR_MATCH,
  descriptorDistance,
  descriptorOfElement,
  isGeomDescriptorId,
  narrowByDescriptor,
  parseGeomDescriptorId,
  type GeomDescriptor,
} from "./geomDescriptor"
import { failLoud } from '@/utils/invariants'
import { isDevOrTestBuild } from "./isDevBuild"
import {
  isClassifierId,
  isGeomHashId,
  isConstructionUuidId,
  parseConstructionUuidId,
  parseAncestry,
  parseAbsolute,
  localFromString,
  localKeyFor,
} from './queryWire'
import type { LocalQuery, AncestryQuery, Query } from "@/types/query"
import { AmbiguousQueryError, coerceType, isDict, isSubtype, objType } from './queryCoerce'

/** Local alias for the canonical Query union (re-exported by query.ts as QueryType). */
type QueryType = Query

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

/**
 * Canonical frozenset key: dedup + sort + join (value-equal across
 * permutations). Ids are internally generated (feature ids, sketch entity ids,
 * profile-query text, construction uuids) and none may contain the NUL
 * separator: unescaped, a NUL would silently merge two DISTINCT ancestor sets
 * into one key (`["a\u0000b","c"]` keys like `["a","b\u0000c"]`), producing
 * wrong merges and wrong evictions. A NUL is a bug upstream, so it fails loud
 * in dev/test (failLoud throws in test, warns in dev). The check is skipped in
 * production because the ids are validated by construction.
 */
export function canonical(ids: Iterable<string>): string {
  const uniq = [...new Set(ids)]
  if (isDevOrTestBuild()) {
    for (const id of uniq) {
      if (id.includes("\u0000")) {
        failLoud(
          `canonical: repository key id ${JSON.stringify(id)} contains the ` +
            `NUL key separator; two distinct ancestor sets would merge into ` +
            `one key`,
        )
        break
      }
    }
  }
  return uniq.sort().join("\u0000")
}

/**
 * True when a full ancestor token (`@<id>`) is a feature reference. gc() keys
 * on feature activity, so only feature refs pin an entry to a feature;
 * construction uuid tokens (`@u|`), classifiers (`@cls_*`), body tags
 * (`@body_*`), geom-hash refs (`@gface_`/`@gedge_`/`@gvertex_`/`@gnormal_`)
 * and legacy descriptors (`@gdf|`/`@gde|`/`@gdv|`) are entity/geometry
 * identity, never feature references: comparing them to feature ids would
 * wrongly evict an entry whose only @-tags are non-feature (e.g. a
 * uuid+body producer) while its body is still registered. Sketch-entity
 * profile-query ids (`@sk1/line1`, `@sk9/r1`) and the test-fixture family
 * `@profile_<fid>` are intentionally NOT excluded: they are never feature ids
 * and always co-occur with a real `@<featureId>` ref, so they cannot pin an
 * entry or wrongly evict one.
 */
export function isFeatureRefTag(tag: string): boolean {
  if (isConstructionUuidId(tag)) return false
  if (isClassifierId(tag)) return false
  if (isGeomHashId(tag)) return false
  if (isGeomDescriptorId(tag)) return false
  return !tag.startsWith("@body_")
}

function isSubset(small: ReadonlySet<string>, big: ReadonlySet<string>): boolean {
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

  /** Entries whose ancestor set contains every id in `querySet`, found through the
   *  `byAncestorId` reverse index instead of scanning all of `ancestral`. Same
   *  narrowing `evictAncestryAndRegister` does, and for the same reason: a resolve
   *  on a 62k-entity assembly walked the whole repo per query.
   *
   *  Exactness: a matching entry must be indexed under EVERY query id, so the
   *  RAREST id's key set is a complete superset of the answer, and re-testing the
   *  subset on it yields exactly what the full scan yielded. Order is preserved
   *  too, since a key enters `byAncestorId` in the same pass that puts its entry
   *  in `ancestral`, so the rarest set iterates as a subsequence of the full scan
   *  (queryAll returns its candidates in that order). */
  private entriesContainingAll(querySet: ReadonlySet<string>): AncestralEntry[] {
    let rarest: Set<string> | null = null
    for (const id of querySet) {
      const keys = this.byAncestorId.get(id)
      if (keys === undefined) return []  // nothing carries this id, so nothing can contain the whole set
      if (rarest === null || keys.size < rarest.size) rarest = keys
    }
    // An empty query set is a subset of every entry; keep the full-scan answer so
    // this helper is a drop-in for the scan regardless of the caller's guards.
    if (rarest === null) return [...this.ancestral.values()]
    const out: AncestralEntry[] = []
    for (const key of rarest) {
      const entry = this.ancestral.get(key)
      if (entry === undefined) continue  // index rot: a dangling key resolves to nothing
      if (isSubset(querySet, entry.set)) out.push(entry)
    }
    return out
  }

  /** Live element ids of every entry whose set is a SUBSET of `querySet` - the
   *  ancestral-partial tier's candidate set, in `ancestral` insertion order.
   *
   *  The full scan it replaces tested `isSubset(entry.set, querySet)` over every
   *  entry on the miss path (the common case for a stale persisted query,
   *  repeated per frame during hover/selection over a large import). Here the
   *  candidate keys are found through `byAncestorId`: union the bucket of every
   *  query id (a partial match shares at least one query id, so it is indexed
   *  under one of them), plus the empty-set entries that no bucket carries (an
   *  entry with no ancestors is a subset of every query set). Then `ancestral`
   *  is re-walked once in insertion order, keeping only those candidate keys and
   *  re-applying the real `isSubset` predicate so the index cannot invent a
   *  match - the per-entry set arithmetic is gone, replaced by an O(1) key
   *  membership test, and order is preserved exactly. Exposed (not private) so
   *  the resolver parity tests can assert the enumeration order directly. */
  partialEntryEids(querySet: ReadonlySet<string>): string[] {
    const keys = new Set<string>()
    for (const id of querySet) {
      const bucket = this.byAncestorId.get(id)
      if (bucket) for (const k of bucket) keys.add(k)
    }
    const out: string[] = []
    for (const [key, entry] of this.ancestral) {
      if (keys.has(key) || entry.set.size === 0) {
        if (isSubset(entry.set, querySet)) out.push(...this.liveEntryEids(entry))
      }
    }
    return out
  }

  /** Narrow candidates by the wanted classifier tokens (the bare `cls_*` names
   *  behind the `@cls_*` wire tokens), scoping the veto to REAL evidence.
   *  Classifiers are world-frame best-effort and the `@u|` uuid tier is the
   *  primary identity (see geomHash.ts), so an element with NO classifiers
   *  carries no evidence and can never contradict the wanted set - it must not
   *  be vetoed, or persisted pre-uuid edge picks (whose registered payloads
   *  collapse to [] for OCC-B-rep edges, see the knowledgebase follow-up) would
   *  regress. Priority:
   *    1. candidates whose payload carries every wanted token (a positive match
   *       outranks no-evidence: an empty-payload sibling must not dilute the
   *       narrowing into a false ambiguity);
   *    2. candidates whose payload carries SOME wanted token (a partial match is
   *       positive evidence, not a contradiction: a wanted set is a snapshot of
   *       an earlier geometry and a moved face can legitimately lose a token, so
   *       vetoing it would break the persisted plane-on-face rescue that the
   *       legacy descriptor tier exists for, see pickIdentityCorpus);
   *    3. else the no-evidence candidates (the only non-contradicted ones), so
   *       resolution proceeds exactly as it did before this feature, except in
   *       a MIXED set where a no-evidence sibling resolves (with the full set
   *       kept pre-feature it threw AmbiguousQueryError) - intended, per the B1
   *       fix;
   *    4. else [] - every candidate carried evidence with NO wanted token in
   *       common (a pure contradiction). The resolver turns it into a miss and
   *       gates the legacy descriptor-only fallback off, queryAll into [] -
   *       never the un-narrowed set.
   *  Shared by the subset and ancestral-partial tiers. */
  private narrowByClassifier(candidateIds: string[], classifierIds: string[]): string[] {
    const wanted = new Set(classifierIds.map(c => c.slice(1)))
    const matching: string[] = []
    const partial: string[] = []
    const noEvidence: string[] = []
    for (const eid of candidateIds) {
      const el = this.elements.get(eid)
      // Only an array is real classifier evidence; a snapshot-restored element
      // can carry a non-array `classifiers` payload (the untrusted route), and
      // `new Set(nonIterable)` throws, so guard before building the set.
      const rawCls = isDict(el) ? el["classifiers"] : null
      const cls = new Set(Array.isArray(rawCls) ? (rawCls as string[]) : [])
      if (cls.size === 0) {
        noEvidence.push(eid)
      } else if (isSubset(wanted, cls)) {
        matching.push(eid)
      } else {
        for (const t of wanted) {
          if (cls.has(t)) {
            partial.push(eid)
            break
          }
        }
      }
    }
    if (matching.length) return matching
    if (partial.length) return partial
    if (noEvidence.length) return noEvidence
    return []
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

  /**
   * Evict entries whose feature refs are all inactive. Liveness model: gc keys
   * on FEATURE activity. An entry lives while any of its feature-shaped tags
   * (`@<featureId>`, e.g. the `@createdBy` every producer emits) names an
   * active feature; a feature's elements die when the feature leaves the order.
   * Body ownership is NOT a gc concern: bodies are re-registered and evicted by
   * index-tag registration (`evictAncestryAndRegister` / `clearBodyAncestry`,
   * see index-shrink-ghost-eviction), so body tags and entity/geometry identity
   * tags (`@u|`, `@cls_*`, `@gface_*`, `@gd*|`, `@body_*`) are classified away
   * before anything is compared to feature ids. Tagless entries (builtin
   * planes) always live.
   */
  gc(activeFids: Set<string>): void {
    for (const [key, entry] of [...this.ancestral]) {
      const refs = new Set<string>()
      for (const tag of entry.set) {
        if (!tag.startsWith("@") || !isFeatureRefTag(tag)) continue
        refs.add(tag.slice(1))
      }
      if (refs.size === 0) continue  // keep tagless entries (builtin planes)
      let intersects = false
      for (const r of refs) if (activeFids.has(r)) { intersects = true; break }
      if (!intersects) {
        for (const eid of entry.eids) this.deleteElement(eid)
        this.deleteAncestral(key)
      }
    }
    this.prunePendingUuids()
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
      // Parse then route through queryTyped so the string and typed local paths
      // share ONE lookup (the full-id-first tie-break plus the slash-key
      // fallback); localFromString's split has eid + sub == the whole body, so
      // the shared probe reads identically from either entry point.
      return this.queryTyped(localFromString(queryStr), context, bodyStore, currentFeatureId)
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

  /** Shared local lookup for the string and typed paths. `q.eid + (q.sub ?? "")`
   *  is the authoritative whole-id reading (it reconstructs the wire body that
   *  `localFromString` split), so a registered element whose WHOLE id is that
   *  string wins the tie-break first - a minted base64url id ending in a
   *  vertex-key word still resolves as the whole id, not as the shorter id plus
   *  a phantom sub (mirroring resolveLocal in partDocToSketches.ts and
   *  resolveQueryRef in geometryMapping.ts). The slash key
   *  `context + eid + "/" + sub` is the fallback, hit only when the full id is
   *  not an entity (the `$pwfYD59xKWiSyQhmcenter` sub-point case whose residual
   *  is the known entity). */
  private resolveLocalKey(q: LocalQuery, context: string): unknown {
    const full = this.elements.get(context + q.eid + (q.sub ?? ""))
    if (full !== undefined) return full
    return this.elements.get(localKeyFor(context, q)) ?? null
  }

  private queryTyped(
    q: QueryType,
    context: string | null,
    bodyStore: Record<string, unknown> | null,
    currentFeatureId: string | null,
  ): unknown {
    switch (q.kind) {
      case "local": {
        if (context === null) return null
        this.assertLocalContext(context)
        return this.resolveLocalKey(q, context)
      }
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
    // The one deliberate exception is the order-hidden case: when the ordering
    // guard's 'continue' fires (the live uuid element is not visible from here),
    // the query falls through to the weaker tiers, exactly as queryAll pins in
    // resolveAllAncestryIds. That fallthrough is safe because the weaker tiers
    // order-filter too, so they still cannot resolve the hidden element.
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
    let classifierVetoFired = false
    let querySet = new Set<string>()
    if (nonHashIds.length) {
      querySet = new Set(nonHashIds)
      for (const entry of this.entriesContainingAll(querySet)) {
        candidateIds.push(...this.liveEntryEids(entry))
      }
    }
    candidateIds = orderFilter(candidateIds)

    if (classifierIds.length && candidateIds.length) {
      // Classifier tier: narrow the subset candidates by the wanted @cls_* set.
      // It runs BEFORE the type/coerce block so a contradicted candidate is
      // vetoed even when the type restriction would otherwise coerce it to a
      // supertype and return early (the M1 bug: `:face` over a lone flatface
      // returned the contradicted element without ever consulting the wanted
      // classifier). The veto is scoped to REAL evidence (narrowByClassifier):
      // an empty payload is no evidence and never vetoes, so a lone edge whose
      // registered payload collapses to [] (the pre-existing solidToEdges vs
      // edgeAncestryPayload asymmetry) still resolves as it did before, and a
      // candidate sharing ANY wanted token is positive evidence, not a
      // contradiction (a wanted set snapshots an earlier geometry - a moved face
      // can lose a token, and the legacy descriptor tier exists to rescue that
      // persisted query). Only a PURE contradiction (every candidate's non-empty
      // payload has NO wanted token in common) vetoes: a lone candidate is
      // refused as a miss, and a multi-candidate set is vetoed as a whole -
      // candidateIds empties exactly like queryAll's unconditional assignment,
      // so the descriptor tier and the descriptor-only fallback cannot shrink
      // the contradictory set to a wrong winner. Narrowing here works on repo
      // eids only, so coerceType's upward `:solid` body-store object (not an
      // eid, no payload) is naturally never classified - a non-contradicted
      // upward coercion still resolves to the body, a contradicted one misses.
      const narrowed = this.narrowByClassifier(candidateIds, classifierIds)
      if (narrowed.length) {
        candidateIds = narrowed
      } else if (candidateIds.length === 1) {
        return null
      } else {
        candidateIds = []
        classifierVetoFired = true
      }
    }

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
          const coerced = coerceType(element, typeRestriction, bodyStore, this, querySet, orderFilter)
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
      let partialCandidates = this.partialEntryEids(querySet)
      partialCandidates = orderFilter([...new Set(partialCandidates)])
      if (typeRestriction !== null) {
        partialCandidates = partialCandidates.filter(
          eid => objType(this.elements.get(eid)) === typeRestriction,
        )
      }
      // The partial tier only resolves a single hit; a wanted @cls_* set must
      // narrow that hit before it is returned, or `?@ex1@extra@cls_zp` could
      // resolve a lone sibling carrying `cls_zn` labeled "ancestral-partial".
      if (classifierIds.length && partialCandidates.length) {
        partialCandidates = this.narrowByClassifier(partialCandidates, classifierIds)
      }
      if (partialCandidates.length === 1) {
        this._lastTier = "ancestral-partial"
        return refuseUuidSwap(this.elements.get(partialCandidates[0]) ?? null)
      }
    }

    if (!candidateIds.length && descriptorIds.length && !classifierVetoFired) {
      // Descriptor-only fallback: fires whenever the ancestry tiers produced no
      // candidate, i.e. when the query had no non-special ancestry tokens, or
      // they were present but failed to match or coerce (candidateIds is empty).
      // Match TIGHT only. A fired classifier veto must gate it off too: the
      // fallback scans EVERY element with no classifier re-check, so after a
      // total veto it would otherwise tight-match a contradictory element that
      // the partial tier already refused (the veto is a veto, matching
      // queryAll's []).
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

  // Superset enumeration is only the ancestral-tier core: the uuid tier, the
  // []-on-type-exclusion and the coerceType fallback all diverge from it. The
  // aligned contract is the resolveAllAncestryIds doc comment below.
  queryAll(
    queryStr: string,
    currentFeatureId: string | null = null,
    bodyStore: Record<string, unknown> | null = null,
  ): unknown[] {
    if (!queryStr || queryStr[0] !== "?") return []
    const orderFilter = this.orderFilter(currentFeatureId)
    const [ids, typeRestriction] = parseAncestry(queryStr)
    return this.resolveAllAncestryIds(ids, typeRestriction, orderFilter, bodyStore)
  }

  queryAllTyped(
    q: AncestryQuery,
    currentFeatureId: string | null = null,
    bodyStore: Record<string, unknown> | null = null,
  ): unknown[] {
    const orderFilter = this.orderFilter(currentFeatureId)
    return this.resolveAllAncestryIds(q.ancestorIds, q.typeRestriction, orderFilter, bodyStore)
  }

  /** Multi-result analogue of resolveAncestryIds for queryAll/queryAllTyped.
   *
   *  Alignment decisions vs the single-result resolver (queryall-special-token-trap):
   *  - Guard: a query whose ids are ALL special tokens (uuid/classifier/geom-hash/
   *    descriptor) never enumerates the whole repo. A uuid-only query returns that
   *    uuid's bucket; every other special-only query returns [].
   *  - UUID tier first and exclusive: a query naming a live uuid returns exactly
   *    that bucket's live elements (order- and type-filtered). Classifiers and
   *    descriptors never narrow the uuid tier, exactly as the resolver's uuid tier
   *    ignores them. A live uuid element that the type restriction excludes yields
   *    [] with NO weaker-tier fallback - the multi-result shape of refuseUuidSwap,
   *    softened because an enumeration has no single wrong element to swap to. A
   *    dead or order-hidden uuid bucket falls through to the ancestral tier, the
   *    resolver's "continue".
   *  - Where the resolver must fail loud, enumeration answers: a bucket holding
   *    2+ live elements (collision by construction) and a query naming 2+ distinct
   *    uuids both enumerate the deduped bucket union, order- and type-filtered like
   *    every other uuid-tier result. The resolver throws because it must pick one;
   *    queryAll has no pick to make.
   *  - The type restriction filters by subtype directly (t === typeRestriction ||
   *    isSubtype). Exact-preference is deliberately NOT applied: an enumeration has
   *    no single preferred answer, so a "face" query returns faces AND flatfaces.
   *    The resolver only prefers the exact face when one exists; with no exact face
   *    it too passes subtypes through via the same coerceType fallback (upward to
   *    solid, or sibling), which also runs here when nothing subtype-matches; an
   *    internal AmbiguousQueryError from coerceType propagates.
   *  - Classifier narrowing applies to the ancestral candidate set; a total veto
   *    (narrowByClassifier -> []) yields [] - the multi-result shape of the
   *    resolver's classifier miss/ambiguity, never the un-narrowed set.
   *  - The ancestral-partial and descriptor-only global fallbacks are not ported:
   *    queryAll's contract is superset enumeration, not recovery of a single
   *    element. Legacy descriptor tokens still narrow a multi-candidate ancestral
   *    set exactly as the resolver's descriptor tier does. */
  private resolveAllAncestryIds(
    ids: string[],
    typeRestriction: string | null,
    orderFilter: (eids: string[]) => string[],
    bodyStore: Record<string, unknown> | null,
  ): unknown[] {
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

    const uuidTokens = [
      ...new Set(
        uuidIds.map(parseConstructionUuidId).filter((u): u is string => u !== null),
      ),
    ]
    if (uuidTokens.length) {
      const liveBucket: string[] = []
      const seen = new Set<string>()
      for (const uuid of uuidTokens) {
        for (const eid of this.byUuid.get(uuid) ?? []) {
          if (this.elements.has(eid) && !seen.has(eid)) {
            seen.add(eid)
            liveBucket.push(eid)
          }
        }
      }
      if (liveBucket.length) {
        const ordered = orderFilter(liveBucket)
        if (ordered.length) {
          let filtered = ordered
          if (typeRestriction !== null) {
            filtered = filtered.filter(eid => {
              const t = objType(this.elements.get(eid))
              return t === typeRestriction || isSubtype(t, typeRestriction)
            })
          }
          // A type-excluded live uuid returns [] (no weaker-tier fallback), so the
          // caller never sees a different element enumerated in the uuid's place.
          this._lastTier = "uuid"
          return filtered.map(eid => this.elements.get(eid))
        }
        // Order-hidden bucket falls through like the resolver's "continue": the
        // weaker tiers order-filter too, so the hidden element stays excluded.
      }
    }

    // Guard: no non-special ids means the query set is empty; subset({}, set) is
    // trivially true for every entry, so without this check a classifier/hash-only
    // query would enumerate the whole repo (the original trap).
    if (!nonHashIds.length) {
      this._lastTier = "miss"
      return []
    }

    const querySet = new Set(nonHashIds)
    let candidateIds: string[] = []
    for (const entry of this.entriesContainingAll(querySet)) {
      candidateIds.push(...this.liveEntryEids(entry))
    }
    candidateIds = orderFilter(candidateIds)

    if (typeRestriction !== null && candidateIds.length) {
      const subtypeMatches = candidateIds.filter(eid => {
        const t = objType(this.elements.get(eid))
        return t === typeRestriction || isSubtype(t, typeRestriction)
      })
      if (subtypeMatches.length) {
        candidateIds = subtypeMatches
      } else {
        const coercedResults: unknown[] = []
        const seen = new Set<unknown>()
        for (const eid of candidateIds) {
          const element = this.elements.get(eid)
          const coerced = coerceType(element, typeRestriction, bodyStore, this, querySet, orderFilter)
          if (coerced !== null && coerced !== undefined && !seen.has(coerced)) {
            seen.add(coerced)
            coercedResults.push(coerced)
          }
        }
        if (coercedResults.length) {
          this._lastTier = "ancestral"
          return coercedResults
        }
        candidateIds = []
      }
    }

    if (classifierIds.length && candidateIds.length) {
      candidateIds = this.narrowByClassifier(candidateIds, classifierIds)
    }

    if (candidateIds.length > 1 && descriptorIds.length) {
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

    // The tier is honest about an empty enumeration: a classifier veto or a type
    // coercion that narrowed to nothing is a miss, not an ancestral hit.
    this._lastTier = candidateIds.length ? "ancestral" : "miss"
    return candidateIds.map(eid => this.elements.get(eid))
  }
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
