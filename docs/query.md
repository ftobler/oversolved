# Query System

The solver uses queries to reference geometry. A query is a string (or typed object) that identifies an element registered in the `Repository`.

## ID Conventions

- **Feature IDs**: user-assigned in the YAML document, never change.
- **Element IDs within a feature**: user-assigned at creation. Sub-element suffixes (`start`, `end`, `center`, `xy`) identify sub-portions.
- **Auto-generated topology IDs**: `genId()` → `el_<base36 counter>` (e.g. `el_0`, `el_1a`), assigned during `registerAncestor`.

There are two element-key conventions, one per repository:

- **Local sketch repo** (concatenated): no separator. Example: `sketch1line1start`.
- **Global repo** (slash-separated): Example: `sketch1/line1/start`. Matches `@` `AbsoluteQuery` resolution (`feat + "/" + ele + "/" + sub`) and, for `$` `LocalQuery` resolution, the registered `featureId/eid/sub` sub-point keys.

## Query Syntax

| Prefix | Kind | Description |
|--------|------|-------------|
| `$<ELE><SUB>` | Local | Element within current feature context. Resolved as `context + eid` (bare) or `context + eid + "/" + sub` (sub-point), matching the slash-registered `featureId/eid/sub` keys. |
| `@<FEAT>/<ELE>/<SUB>` | Absolute | Cross-feature lookup by slash-separated key `feat + "/" + ele + "/" + sub`. |
| `?<H,L>;<idA><idB>[:TYPE]` | Ancestry | Ancestry-based query with hex-encoded lengths and optional type filter. |

Dispatched by `Repository.query()` on the first character. Sub suffixes require a non-alphanumeric character before them to avoid false matches (e.g. `sketch_start` ≠ `sketch_` + `start`).

## Geometry Types

| Type | Description | Parent |
|------|-------------|--------|
| `solid` | 3D solid body | - |
| `face` | General face | - |
| `flatface` | Planar face | `face` |
| `cylinderface` | Cylindrical face | `face` |
| `edge` | Non-straight edge | - |
| `straightedge` | Straight edge | `edge` |
| `vertex` | Topological vertex | - |

A query for a parent type also matches subtypes (e.g. `face` matches `flatface`).

## Construction UUIDs (`@u|<uuid>`)

The primary identity tier. Every produced face/edge/vertex carries a UUID
derived from HOW it was constructed (feature ids, sketch entity ids, cap roles,
parent UUIDs, split indices), never from where it sits in space
(`constructionName.ts`). The ingredients are symbolic, so the UUID recomputes to
the same value on every rebuild and a persisted token still matches after a
reload. The one confined use of geometry is `orderSplitChildren`, which sorts
genuine split siblings by their arrangement in the parent's own frame into
stable integer indices; that relative key is consumed at mint time and never
stored or emitted.

Wire form: `@u|<uuid>` tokens ride the length-prefixed ancestry id list like the
`@cls_*` tokens, and are registered in `Repository.byUuid`.

Fail-loud contract (`refuseUuidSwap`, `query.ts`): a query naming a live UUID
resolves to the element carrying that UUID or throws. It must never fall
through to a weaker tier and silently return a DIFFERENT element.

- 2+ distinct UUID tokens in one query, or one UUID matching 2+ live elements
  (a collision by construction), throw `AmbiguousQueryError`. The multiplicity
  check runs BEFORE the type/order filters so a genuine collision cannot be
  narrowed away.
- When the type restriction excludes the live UUID element, the weaker tiers may
  only resolve nothing; any non-null weaker-tier result throws instead.
- The one deliberate fallthrough is the order-hidden case: when the ordering
  guard hides the UUID element, resolution continues into the weaker tiers,
  which order-filter too and so still cannot reach it.

`queryAll` mirrors this: a live UUID enumerates exactly that bucket, a
type-excluded bucket yields `[]` with no fallback, and where the resolver must
throw (collision, multiple UUIDs) the enumeration just returns the deduped
union, since it has no single element to pick wrongly.

## Geometric Classifiers

An edit-stable tie-break tier BELOW the UUID tier, disambiguating elements that
share ancestry (genuine siblings of one operation).

Wire form: classifier tokens are minted `@cls_*` and ride the existing
length-prefixed ancestry id list (no grammar change), exactly like the `@u|`
uuid tokens. `isClassifierId` partitions them out of the ancestral subset match;
`narrowByClassifier` then narrows the ancestral candidates by them. The veto is
scoped to REAL evidence, in priority order: candidates carrying every wanted
token, else candidates carrying some wanted token (a wanted set snapshots an
earlier geometry, so a partial match is evidence, not a contradiction), else the
candidates with no classifier payload at all (no evidence never vetoes). Only a
pure contradiction (every candidate carries evidence and none of it is wanted)
empties the set, which the resolver reports as a miss rather than falling
through to a wrong winner. Each face/edge element carries its bare token list in
`payload["classifiers"]`; the matching `@cls_*` tokens are embedded in the
element's query.

- **Cardinal / axial** (Phase 1, implemented): `@cls_xp`/`@cls_xn`/`@cls_yp`/
  `@cls_yn`/`@cls_zp`/`@cls_zn` -- which end of the body AABB an element's
  representative point sits past, per world axis (`geometry_classifiers`). Splits
  extrude caps and cylinder rims; the only edit-stable discriminator for sibling
  edges that predate the UUID tier. Stable under translation + per-axis scale;
  not under body-reorienting rotation (body-local axes are future work).
- **Line division** (implemented): a sketch surface split from a same-ancestry
  sibling by a line (e.g. a circle cut by a line) carries `cls_ld_<lineid>_p|n`,
  the side of each shared bounding line taken in a canonical direction. A stable
  alternative to the positional `surface:N` index. Stamped in
  `frontend/src/kernel/topologyDecorate.ts` and registered on the surface
  element's payload.
- **Circle containment** (investigated, not needed): concentric regions do not
  share ancestry -- a disk and the ring around it are each identified by their
  own bounding circle (`{@sk/inner}` vs `{@sk/outer}`; the hole circle is in the
  ring's boundary but not its ancestry), so they already resolve by distinct
  lineage with no tie to break. The `classify_surface_by_circle_side` primitive
  stays unwired.

## Feature-Plane References (`@<FEAT>`)

`@<FEAT>` where FEAT matches a registered feature ID resolves via flat lookup in `self.elements`. Sketches, extrudes, and built-in planes are registered this way. Must match the registered key exactly (slash-separated for element/sub keys, e.g. `@sketch1/line1/start`).

## 3D B-rep Face Queries

Faces of 3D bodies use:

```
?d,d;@extrude1face0:flatface
```

The ancestor ID combines feature ID with a face index. Resolution: parse → lookup in `Repository.ancestral` by subset match → filter by type → return.

Frontend: Three.js `faceIndex` → `triangle_to_face` → B-rep face number → `face_queries[faceIndex]` → query string.

## Repository Resolution

`Repository.query(queryStr, context, bodyStore, currentFeatureId)`:

- **`$` (local)**: requires a slash-terminated `context` (null is also allowed, returning null). Looks up `this.elements[context + eid]` for a bare local, or `this.elements[context + eid + "/" + sub]` for a sub-point, matching the slash-registered `featureId/eid/sub` keys.
- **`@` (absolute)**: looks up `this.elements[feature_id + eid + sub]`.
- **`?` (ancestry)**: resolves the `@u|` UUID tier first (see above); failing that, finds elements whose registered ancestor set is a **superset** of the query's provenance ids (`query ⊆ registered`). If `type_restriction` given, filters to exact type matches first, then attempts type coercion. Raises `AmbiguousQueryError` if multiple candidates match. The relaxed `registered ⊆ query` direction is the ancestral-partial fallback, and only when it finds exactly one element.

### Type Coercion

When a type-restricted query finds no exact match:
1. **Subtype match**: element returned as-is (e.g. `flatface` matches `face`)
2. **Upward (child → solid)**: if target is `solid`, returns parent from `body_store`
3. **Downward/sibling scan**: scan repo by `body_id`

### Repository.query_all

Finds elements whose registered ancestor set is a **superset** of the query's set (`query ⊆ registered`). Used to enumerate topology belonging to a feature. Only works with `?` queries.

## Resolution Decision Tree

`resolveAncestryIds` (`frontend/src/kernel/query.ts`). The tier that answered is
recorded in `_lastTier` (`uuid` | `ancestral` | `ancestral-partial` |
`descriptor` | `miss`) so a corpus test catches a query silently degrading to a
weaker tier.

```
Parse → ids, type_restriction
  ↓
Partition ids → provenance (ancestry) | uuids (@u|) | classifiers (@cls_*)
                | legacy descriptors (@gd*|) | legacy geom hashes (@g*_, ignored)
  ↓
UUID tier (primary): 2+ distinct uuids, or one uuid on 2+ live elements
  → AmbiguousQueryError (counted before type/order filters)
  live + visible + type-compatible → return  [uuid]
  dead bucket, or order-hidden → fall through
  type-excluded → fall through with refuseUuidSwap armed: any non-null result
    from a weaker tier is a different element → AmbiguousQueryError
  ↓
Ancestral tier: candidates where provenance_set ⊆ registered_key; live-filter;
  order-filter
  ↓
Type restriction: keep exact-type matches; else coerce (subtype/upward/downward),
  1 coercion → return  [ancestral], >1 distinct coercions → AmbiguousQueryError,
  0 → candidates := []
  ↓
Classifier tier: narrow by real evidence (full match > partial match >
  no-evidence); a pure contradiction refuses a lone candidate as a miss and
  vetoes a multi-candidate set to []
  ↓
Legacy descriptor tier (if >1 candidates): narrow by @gd*| descriptors
  ↓
Fallbacks when the ancestral tier found nothing:
  |-- partial ancestral (registered_key ⊆ provenance_set), order/type/classifier
  |   filtered, exactly 1 → return  [ancestral-partial]
  |-- descriptor-only tight match over all elements, unless the classifier veto
  |   fired  [descriptor]
  ↓
0 → null | 1 → element (through refuseUuidSwap) | >1 → AmbiguousQueryError
```

There is no geometry-hash resolution tier. `@gface_`/`@gedge_`/`@gvertex_`/
`@gnormal_` tokens are only partitioned out of old persisted queries and
otherwise ignored; geometry hashes live on as body-side lookup keys
(`face_names`, brep diffing), never as identity. Identity is the construction
UUID plus the ancestral path.

The classifier and descriptor tiers only ever *narrow* an already
ancestry-matched candidate set, so neither can reach across lineages.
