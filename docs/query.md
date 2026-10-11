# Query System

The kernel uses queries to reference geometry. A query is a string (or typed
`Query` object, `frontend/src/types/query.ts`) that names an element registered
in the `Repository` (`frontend/src/kernel/queryRepository.ts`). The wire codec
lives in `queryWire.ts`, type coercion in `queryCoerce.ts`, registration and
eviction in `queryAncestryOps.ts`; `query.ts` is the barrel.

## ID Conventions

- **Feature IDs**: minted at creation (`randomId`), never change.
- **Element IDs within a feature**: minted at creation. Sub-element suffixes
  (`start`, `end`, `center`, `xy`) identify sub-portions.
- **Repository element ids**: `genId()` -> `el_<base36 counter>`, assigned by
  `registerAncestor`. Internal only; never persisted in a document.

Element keys registered under a fixed name are slash-separated:
`featureId/eid/sub` (e.g. `sketch1/line1/start`).

## Query Syntax

| Prefix | Kind | Resolution |
|--------|------|------------|
| `$<ELE>[<SUB>]` | Local | `context + eid`, or `context + eid + "/" + sub` for a sub-point. `context` must end in `/`. |
| `@<FEAT>[/<ELE>[/<SUB>]]` | Absolute | Flat lookup of the slash-joined key. 1 to 3 non-empty parts; anything else is rejected. |
| `?<H,L,...>;<id><id>...[:TYPE]` | Ancestry | Hex lengths frame the concatenated ids; optional type restriction. |

`Repository.query()` dispatches on the first character.

The ids of an ancestry query play three roles (`partitionAncestryIds`):

| Token | Role |
|-------|------|
| `@u|<uuid>` | Construction UUID, the primary identity. |
| `@cls_*` | Classifier, a tie-break that only narrows. |
| anything else | Lineage: the ancestral path the subset match runs on (`@<feature>`, `@body_*`, sketch-entity tokens, ...). |

There is no other token family. Geometry hashes and geometric descriptors are
not part of a query, and old documents that carried them are not supported: a
stored `@gface_`/`@gedge_`/`@gd*|` token is now plain lineage that no element
carries, so such a pick misses (shows red) and has to be re-picked.

## Geometry Types

| Type | Parent |
|------|--------|
| `solid` | - |
| `face` | - |
| `flatface`, `cylinderface`, `coneface`, `sphereface`, `torusface` | `face` |
| `edge` (any non-straight edge) | - |
| `straightedge` | `edge` |
| `vertex` | - |

A query for a parent type also matches its subtypes (`face` matches `flatface`).

## B-rep Primitive Queries

Every face, edge and vertex of a body gets a query minted at tessellation
(`buildFaceQuery` in `faceQuery.ts`, `solidToEdges` / `solidToVertices` in
`occ/tessellation.ts`):

```
?<lengths>;@u|<uuid>@<createdBy>@body_<id><ancestry tokens>@cls_*...:<type>
```

The builder registers the same primitive under its ancestor set
(`builderAncestry.ts`): the index tag `@body_<id>/face<N>`, the creating
feature, the body, and the ancestry tokens; the UUID goes to `byUuid` and the
classifiers to the element payload. An edge's payload classifiers are read from
its own minted query (`classifiersOfQuery`), so the two cannot disagree.

Invariant (`querySelfResolutionReal.test.ts`): every emitted query resolves to
the very element registered for that primitive through the UUID tier. With
its UUID removed, the ancestral net resolves it to that element, or is
ambiguous among siblings that include it; it never misses it and never
resolves a different element.

## Construction UUIDs (`@u|<uuid>`)

The primary identity tier. Every produced face/edge/vertex carries a UUID
derived from HOW it was constructed (feature ids, sketch entity ids, cap roles,
parent UUIDs, split indices), never from where it sits in space
(`constructionName.ts`). The UUID recomputes to the same value on every rebuild.

Fail-loud contract (`refuseUuidSwap`): a query naming a live UUID resolves to
the element carrying that UUID or throws. It never falls through to a weaker
tier and silently returns a DIFFERENT element.

- 2+ distinct UUIDs in one query, or one UUID on 2+ live elements (a collision
  by construction), throw `AmbiguousQueryError`, counted before the type/order
  filters so a collision cannot be narrowed away.
- When the type restriction excludes the live UUID element, a weaker tier may
  only resolve nothing; a non-null weaker-tier result throws.
- When the ordering guard hides the UUID element, resolution continues into the
  weaker tiers, which order-filter too and so cannot reach it.
- Foreign-UUID exclusion (`weakerTierFilter`): whenever the named UUID does not
  answer, every weaker tier (coercion included) drops candidates registered
  under a DIFFERENT UUID. Only elements with no UUID stay recoverable.

## Classifiers (`@cls_*`)

An edit-stable tie-break below the UUID tier, separating elements that share
lineage. Classifier tokens ride the id list like UUID tokens.

- Cardinal / axial `@cls_xp`/`xn`/`yp`/`yn`/`zp`/`zn`: which end of the body
  AABB the element's representative point sits past, per world axis. Stable
  under translation and per-axis scale, not under rotation.
- Line division `@cls_ld_<lineid>_p|n`: the side of a shared bounding line for
  a sketch surface split from a same-lineage sibling (`topologyDecorate.ts`).

`narrowByClassifier` weighs real evidence, in priority order: candidates
carrying every wanted token, else some wanted token, else no classifiers at all
(no evidence never vetoes). A pure contradiction (every candidate carries
evidence, none of it wanted) is a veto: the query misses, whether one candidate
or several were vetoed, and no weaker tier may recover a different element.

Evidence is only weighed among candidates of the requested type
(`typeCompatible`): a face's classifiers say nothing about an edge.

## Resolution Decision Tree

`resolveAncestryIds` (`queryRepository.ts`). The answering tier is recorded in
`_lastTier` (`uuid` | `ancestral` | `ancestral-partial` | `miss`).

```
Partition ids -> uuids | classifiers | lineage
  |
UUID tier: 2+ uuids, or a uuid on 2+ live elements -> AmbiguousQueryError
  live + visible + type-compatible -> return  [uuid]
  dead or order-hidden -> continue, foreign-uuid exclusion armed
  type-excluded -> continue, refuseUuidSwap armed
  |
no lineage -> null
  |
Ancestral tier: entries whose set contains every lineage id; live, order and
  foreign-uuid filtered
  |
Classifier tier (type-compatible pool): narrow; a veto -> null
  |
Type restriction: exact-type matches, else coerce (subtype as-is, upward to
  the body's solid, or a same-body sibling); 1 coercion -> return, 2+ -> throw
  |
Partial tier (only when nothing is left): entries whose set is a SUBSET of
  the lineage and shares at least one id; type then classifier filtered;
  exactly 1 -> return  [ancestral-partial]
  |
0 -> null | 1 -> element (through refuseUuidSwap) | 2+ -> AmbiguousQueryError
```

`queryAll` enumerates instead of picking: a live UUID yields its bucket, a
classifier-only query yields `[]`, and the partial tier is not used.

## Ordering Guard

When `currentFeatureId` is set (or the solve loop's current feature is), the
resolver refuses elements whose owning feature comes after it in the build
order, and elements whose owner left the order. Built-ins are always visible.
