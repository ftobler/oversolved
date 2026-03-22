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

In Anchestry information lists, lengths are hex encoded and comma separated. A semicolon separates it from the id strings which have no delimiters between them. Each ID string must be of valid Query Syntax.

A query is always used to refer to another element. The query should resolve unique. Anchestry information is used up until the query uniquely resolves.

---

When a element is created it's id must be registered. This is done with a dictionary. Elements which do not have a id but only anchestral information are given a new random ID. In a separate anchestral dictionary its anchesters resolve to that random id.


