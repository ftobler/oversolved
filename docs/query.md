# Query System

The solver uses queries to reference geometry. A query is a string (or typed object) that identifies an element registered in the `Repository`.

## ID Conventions

- **Feature IDs**: user-assigned in the YAML document, never change.
- **Element IDs within a feature**: user-assigned at creation. Sub-element suffixes (`start`, `end`, `center`, `xy`) identify sub-portions.
- **Auto-generated topology IDs**: `secrets.token_urlsafe(9)` → 12-char base64url, assigned during `register_ancestor`.

There are two element-key conventions, one per repository:

- **Local sketch repo** (`solver.py` `_get_or_build_repo`): concatenated, no separator. Example: `sketch1line1start`. Matches `$` `LocalQuery` resolution (`context + ele + sub`).
- **Global repo** (`solver_registry.py`): slash-separated. Example: `sketch1/line1/start`. Matches `@` `AbsoluteQuery` resolution (`feat + "/" + ele + "/" + sub`).

## Query Syntax

| Prefix | Kind | Description |
|--------|------|-------------|
| `$<ELE><SUB>` | Local | Element within current feature context. Resolved as `context + ele + sub` (concatenated). |
| `@<FEAT>/<ELE>/<SUB>` | Absolute | Cross-feature lookup by slash-separated key `feat + "/" + ele + "/" + sub`. |
| `?<H,L>;<idA><idB>[:TYPE]` | Ancestry | Ancestry-based query with hex-encoded lengths and optional type filter. |

Dispatched by `parse_query()` first character. Sub suffixes require a non-alphanumeric character before them to avoid false matches (e.g. `sketch_start` ≠ `sketch_` + `start`).

## Geometry Types

| Type | Description | Parent |
|------|-------------|--------|
| `solid` | 3D solid body | — |
| `face` | General face | — |
| `flatface` | Planar face | `face` |
| `cylinderface` | Cylindrical face | `face` |
| `edge` | Non-straight edge | — |
| `straightedge` | Straight edge | `edge` |
| `vertex` | Topological vertex | — |

A query for a parent type also matches subtypes (e.g. `face` matches `flatface`).

## Geometric Classifiers

An edit-stable resolver tier between ancestry and the geometry-hash tie-break,
disambiguating elements that share ancestry (genuine siblings of one operation).

Wire form: classifier tokens are minted `@cls_*` and ride the existing
length-prefixed ancestry id list (no grammar change), exactly like the
`@gface_`/`@gedge_` hash tokens. `_is_classifier_id` partitions them out of both
the ancestral subset match and the hash tier; `_resolve_ancestry_ids` narrows
candidates by them BEFORE the hash, and only when the narrowed set is non-empty
(graceful -- a staled/absent classifier degrades to the hash tier, never zeroes
the result). Each face/edge element carries its bare token list in
`payload["classifiers"]`; the matching `@cls_*` tokens are embedded in the
element's query.

- **Cardinal / axial** (Phase 1, implemented): `@cls_xp`/`@cls_xn`/`@cls_yp`/
  `@cls_yn`/`@cls_zp`/`@cls_zn` -- which end of the body AABB an element's
  representative point sits past, per world axis (`geometry_classifiers`). Splits
  extrude caps and cylinder rims; the only edit-stable discriminator for sibling
  edges (which have no `@gnormal_` fallback). Stable under translation + per-axis
  scale; not under body-reorienting rotation (body-local axes are future work).
- **Line division** (implemented): a sketch surface split from a same-ancestry
  sibling by a line (e.g. a circle cut by a line) carries `cls_ld_<lineid>_p|n`,
  the side of each shared bounding line taken in a canonical direction. A stable
  alternative to the positional `surface:N` index. Stamped in `topology.py` and
  registered on the surface element's payload.
- **Circle containment** `@cls_inner`/`@cls_outer` (deferred): the existing
  `classify_surface_by_circle_side` primitive is geometrically unsound for an
  annulus (the ring's area-centroid sits in the hole), and the disk-vs-ring case
  is a subset-ancestry, not same-ancestry, ambiguity. A correct discriminator
  needs loop-nesting info; left for a follow-up.

## Feature-Plane References (`@<FEAT>`)

`@<FEAT>` where FEAT matches a registered feature ID resolves via flat lookup in `self.elements`. Sketches, extrudes, and built-in planes are registered this way. Must match the registered key exactly (slash-separated for element/sub keys, e.g. `@sketch1/line1/start`).

## 3D B-rep Face Queries

Faces of 3D bodies use:

```
?d,d;@extrude1face0:flatface
```

The ancestor ID combines feature ID with a face index. Resolution: parse → lookup in `Repository.ancestral` by subset match → filter by type → return.

Frontend: Three.js `faceIndex` → backend `triangle_to_face` → B-rep face number → `face_queries[faceIndex]` → query string.

## Repository Resolution

`Repository.query(query_str, context, body_store)`:

- **`$` (local)**: requires `context`. Looks up `self.elements[context + eid + sub]`.
- **`@` (absolute)**: looks up `self.elements[feature_id + eid + sub]`.
- **`?` (ancestry)**: finds elements whose registered ancestor set is a **subset** of the query's set (`registered ⊆ query`). If `type_restriction` given, filters to exact type matches first, then attempts type coercion. Raises `AmbiguousQueryError` if multiple candidates match.

### Type Coercion

When a type-restricted query finds no exact match:
1. **Subtype match**: element returned as-is (e.g. `flatface` matches `face`)
2. **Upward (child → solid)**: if target is `solid`, returns parent from `body_store`
3. **Downward/sibling scan**: scan repo by `body_id`

### Repository.query_all

Finds elements whose registered ancestor set is a **superset** of the query's set (`query ⊆ registered`). Used to enumerate topology belonging to a feature. Only works with `?` queries.

## Resolution Decision Tree

```
Parse → ids, type_restriction
  ↓
Partition ids → provenance (ancestry) | classifiers (@cls_*) | geom hashes (@g*)
  ↓
Ancestral tier: candidates where provenance_set ⊆ registered_key; order-filter
  ↓
Type restriction: keep exact-type matches; else coerce (subtype/upward/downward),
  >1 distinct coercions → AmbiguousQueryError
  ↓
Classifier tier (if >1 candidates): narrow to payload.classifiers ⊇ query
  classifiers; applied only if non-empty (else fall through)
  ↓
Geom-hash tier (if >1 candidates): narrow by precise @gface_/@gedge_/@gvertex_,
  then the @gnormal_ orientation fallback; each applied only if non-empty
  ↓
Fallbacks when the ancestral tier found nothing:
  |-- partial ancestral (registered_key ⊆ provenance_set), unique → return
  |-- precise hash only (no @gnormal_ here) → candidates
  ↓
0 → None | 1 → element | >1 → AmbiguousQueryError
```

The classifier and geom-hash tiers only ever *narrow* an already
ancestry-matched candidate set, so neither can reach across lineages.
