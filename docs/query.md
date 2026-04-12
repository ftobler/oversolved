# query

the solver implements a query based approach to find geometry. the query syntax is made with a string. the following concepts apply:
* Each feature once it is created gets its own unique id. If human written, it can be `sketch1`, but if machine generated it should be `randomBytes(18).toString("base64url")` or similar. Once created it will never change. Id length is 18.
* Each sub element of the feature simply appends its own id to the parent feature id. Operation is simple string concatenation. `feat_id + element_id`. Inside the feature the element can be referred by its `element_id`. If the element has predefined sub elements like a line `start` and `end`, they get appended to the elementid. id length is 12 for the random part.
* Each topology element that is created does not get an id. Instead it gets an annotation how it was built. The concept is called a *query*. Its identifier is the anchrstry list of the source elements. e.g `[element_id1 + "line", element_id2 + "arc"]` meaning it is the result of the intersection between a line and an arc. Nesting such identifiers must be possible and the list unpackable. That works best with slices, which need absolute positions. `"?J,K;<id1><id2>"` where `<id2> = "?A,B;<id3><id4>"` and `J`, `K`, `A`, `B` are hex encoded lengths.

Each element can refer to another one by an id. There are different requirements and types of querys:

| Query Syntax            | Description                                                         |
|-------------------------|---------------------------------------------------------------------|
| `$<ELE>`                | local id inside the feature.                                        |
| `$<ELE><SUB>`           | local id inside the feature with a uniquely identified subelement.  |
| `@<FEAT>`               | feature-plane reference: resolves to the defining plane of that feature (see below). |
| `@<FEAT><ELE><SUB>`     | absolute element lookup by id.                                      |
| `?A,B;<idA><idB>`       | anchrestry information list.                                        |
| `?A,B;<idA><idB>:<TYPE>`| anchrestry information list, restricted to geometry type.           |
| `?A,B;<idA><idB>:<TYPE>@<CLASSIFIER>`| anchrestry list with geometric classifier. |

In Anchestry information lists, lengths are hex encoded and comma separated. A semicolon separates it from the id strings which have no delimiters between them. Each ID string must be of valid Query Syntax. An optional `:<TYPE>` suffix after the id strings restricts resolution to a specific geometry type (e.g. `pt`, `line`, `arc`, `edge`, `face`). This is useful when an intersection produces multiple geometry types and the desired one must be unambiguous.

### Geometric Classifiers

When multiple surfaces are created from the same ancestry (e.g., a circle cut by a line), geometric classifiers disambiguate them by encoding spatial relationships:

**Line Division Classifiers** — When a geometry is divided by a line:
- `@pos` — surface on the positive side (left/above when traversing line from start to end)
- `@neg` — surface on the negative side (right/below when traversing)

**Circle Containment Classifiers** — For surfaces relative to a circle:
- `@inner` — surface inside the circle
- `@outer` — surface outside the circle

**Cardinal Direction Classifiers** — Surface location relative to origin:
- `@north` — surface in positive Y direction
- `@south` — surface in negative Y direction
- `@east` — surface in positive X direction
- `@west` — surface in negative X direction

**Examples:**
```
?5;@sketch_1circle:face@inner    # Inside a standalone circle
?5;@sketch_1circle:face@outer    # Outside a standalone circle
?f,13;@sketch_1circle@sketch_1line:face@pos  # Above the line
?f,13;@sketch_1circle@sketch_1line:face@neg  # Below the line
```

A query is always used to refer to another element. The query should resolve unique. Anchestry information and classifiers are used to make the resolution unambiguous.

### Feature-plane references (`@<FEAT>`)

When `@<id>` appears and `<id>` exactly matches a registered feature ID (with no leftover characters that would form an element ID), it is a **feature-plane reference**. The resolver looks up the feature and returns its defining plane geometry:

- **Sketch** (`@sketch1`): resolves to the sketch's plane transform (origin + rotation). This is the primary use case - selecting a sketch from the feature tree and using it as a plane reference for another sketch or operation.
- **Extrude** (`@extrude1`): resolves to the extrude's origin plane (the sketch plane it was built from) or, if more useful, its top face. The exact resolution policy for non-sketch features is TBD but should default to the most geometrically useful reference plane.
- **Built-in planes** (`@builtin_plane_front`, `@builtin_plane_top`, `@builtin_plane_right`): these are special-cased named feature-plane references and are already fully supported.

**Disambiguation rule**: when parsing `@<string>`, the resolver first checks if `<string>` is a known feature ID. If it is and nothing remains, it is a feature-plane reference. If `<string>` starts with a known feature ID and has leftover characters, those characters form the element ID (`@<FEAT><ELE>`). Machine-generated feature IDs are 24-char base64url (18 bytes), so disambiguation is unambiguous. Human-readable IDs (e.g. `sketch1`) require the resolver to check all registered feature IDs by longest prefix match.

**Frontend convention**: the UI selection system uses `@<featureId>` as the selection ID when a feature is clicked in the feature tree. This is a valid query string that passes through `parseTarget` unchanged and can be used directly as a plane reference in mutations (e.g. `set_feature_plane`).

### 3D B-rep Face Queries

The ancestry query pattern extends to 3D B-rep faces from solid bodies. This enables referencing specific faces of extruded volumes, STEP imports, and other 3D geometry.

**Query format**: Same ancestry pattern `?A,B;<idA><idB>:<TYPE>` with `:face` type restriction.

**ID construction**: For 3D B-rep faces, the ancestor ID combines:
- The feature ID that created the body (e.g., `extrude1`)
- The face index in OCC explorer order (e.g., `face0`, `face1`)

**Example queries:**
```
?d,d;@extrude1face0:face    # Face 0 of extrude1 feature
?d,d;@extrude1face1:face    # Face 1 of extrude1 feature
?14,14;@myextrudeface0@myextrudeface1:face  # Multiple faces
```

**Breaking down the query:**
- `?d,d;` — hex-encoded lengths: `d` (13 in decimal) = len("@extrude1face0")
- `@extrude1face0` — absolute element ID: `@` prefix + feature ID + element ID
- `:face` — type restriction to faces only

**Frontend usage**: When clicking a mesh face in the 3D viewport:
1. Three.js returns `faceIndex` — the triangle index (unstable, changes with tessellation)
2. Backend provides `triangle_to_face` mapping array to convert triangle → B-rep face
3. Backend provides `face_queries` array indexed by B-rep face number
4. Frontend uses the pre-computed query from `face_queries[faceIndex]`

**Resolution path:**
```
Query: "?d,d;@extrude1face0:face"
   ↓ parse (query.py:_parse_ancestry)
IDs: ["@extrude1face0"]
   ↓ lookup (Repository.anchestral)
Registered under: frozenset({"@extrude1face0"})
   ↓ match → return registered object
Result: {"type": "face", "centroid": [...], "normal": [...]}
```

---

When a element is created it's id must be registered. This is done with a dictionary. Elements which do not have a id but only anchestral information are given a new random ID. In a separate anchestral dictionary its anchesters resolve to that random id.


