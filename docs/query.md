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

---

When a element is created it's id must be registered. This is done with a dictionary. Elements which do not have a id but only anchestral information are given a new random ID. In a separate anchestral dictionary its anchesters resolve to that random id.


