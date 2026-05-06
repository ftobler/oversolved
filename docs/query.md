# Query System

The solver uses queries to reference geometry. A query is a string (or typed object) that identifies an element registered in the `Repository`.

## ID Conventions

- **Feature IDs**: user-assigned in the YAML document, never change.
- **Element IDs within a feature**: user-assigned at creation. Sub-element suffixes (`start`, `end`, `center`, `xy`) identify sub-portions.
- **Auto-generated topology IDs**: `secrets.token_urlsafe(9)` → 12-char base64url, assigned during `register_ancestor`.

A fully-qualified key is `feature_id + element_id + sub_suffix`. Example: `sketch1line1start`.

## Query Syntax

| Prefix | Kind | Description |
|--------|------|-------------|
| `$<ELE><SUB>` | Local | Element within current feature context. Resolved as `context + ele + sub`. |
| `@<FEAT><ELE><SUB>` | Absolute | Cross-feature lookup by concatenated key `feat + ele + sub`. |
| `?<H,L>;<idA><idB>[:TYPE][@CLASSIFIER]` | Ancestry | Ancestry-based query with hex-encoded lengths, optional type filter and geometric classifier. |

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

When multiple surfaces share ancestry (e.g. a circle cut by a line), classifiers disambiguate:

- **Line Division**: `@pos` (left/above), `@neg` (right/below)
- **Circle Containment**: `@inner` (inside), `@outer` (outside)
- **Cardinal Direction**: `@north` (+Y), `@south` (-Y), `@east` (+X), `@west` (-X)

Classifiers are parsed and carried in the `AncestryQuery` data model but the resolver does not yet filter on them.

## Feature-Plane References (`@<FEAT>`)

`@<FEAT>` where FEAT matches a registered feature ID resolves via flat lookup in `self.elements`. Sketches, extrudes, and built-in planes are registered this way. Must match the registered key exactly.

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
Parse → extract IDs, type_restriction, classifier
  ↓
Find candidates where registered_key ⊆ query_set
  |-- None → return None
  ↓
Apply type_restriction:
  |-- Exact matches → narrow
  |-- No matches → coerce (subtype/upward/downward)
  |-- Still none → return None
  ↓
Check count:
  |-- 0 → None
  |-- 1 → return element
  |-- >1 → raise AmbiguousQueryError
```
