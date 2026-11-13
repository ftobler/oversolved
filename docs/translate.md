# Translating a CadQuery model

CadQuery is the first translation source because it wraps the same OCCT kernel
family and its workplane / sketch / extrude / fillet / selector vocabulary maps
closely onto Oversolved features plus the `select` tool. A translation case is
three files in `frontend/translations/<NN-name>/`:

- `source.py`: the CadQuery script, run as written, never interpreted by a model.
- `recipe.yaml`: the Oversolved part document, built by the real kernel.
- `reference.json`: the measures CadQuery produced, committed so CI never needs
  the OCP wheel.

The agent loop is: run the reference, author the recipe, pick edges, compare,
iterate, then commit the case.

## 1. Run the CadQuery source

CadQuery is an optional extra, not part of `[dev]`, so CI installs `.[dev]` and
never downloads the OCP wheel. Locally `just install` installs
`.[dev,cadquery]`; to add it to an existing venv:

```bash
.venv/bin/pip install -e ".[dev,cadquery]"
```

The script must name its finished workplane or shape `result` (or `model` /
`part`). The runner injects `cadquery`/`cq`/`Workplane` and a no-op
`show_object`, so the editor hook every corpus example ends with runs without a
viewer and the source is executed unmodified. Then run the reference runner:

```bash
.venv/bin/python frontend/scripts/cadqueryReference.py \
    frontend/translations/02-box-fillet-vertical/source.py \
    --out frontend/translations/02-box-fillet-vertical/reference.json
```

The runner writes `source { tool: "cadquery", version, file }`, the stated
`tolerance`, `topology`, `bodies`, `volume`, `area`, `centroid`, an exact
six-number `bbox` (`[xmin, ymin, zmin, xmax, ymax, zmax]` from
`Shape.BoundingBox()`), and the face and edge counts. Defaults are
`--rel 1e-5 --abs 1e-6 --topology report`; pass `--step out.step` to keep a STEP
export beside the reference. `source.file` is the script's basename, so run the
runner from the repo root with the case directory already in place.

Do not hand-edit the numbers. Rerun the source when it changes.

## 2. Author the Oversolved recipe

Start the MCP server (the JSON-RPC stdio surface over the real kernel):

```bash
cd frontend
node --experimental-strip-types --import=./scripts/driveCli.register.mjs scripts/mcpServer.ts
```

`run` takes mutation steps and returns a `docHash`; chain the next call with
that handle rather than re-sending the document. `select` takes the handle and
returns the query strings a click would store:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run","arguments":{"steps":[
  {"mutation":{"type":"add_sketch","featureId":"sk1","plane":"@builtin_plane_front"}},
  {"mutation":{"type":"add_rect","featureId":"sk1","p0":[0,0],"p1":[20,14],"p0Ref":"@builtin_origin","dimensions":true}},
  {"mutation":{"type":"add_extrude","featureId":"ex1","sketchQuery":"$sk1","distance":10,"operation":"new"}}
]}}}
// result.docHash is the handle for call 2.
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select","arguments":{
  "docHash":"<docHash from call 1>",
  "selector":{"kind":"edge","where":{"and":[{"type":"line"},{"parallel":[0,0,1]}]}}
}}}
```

`select` returns `{ count, queries, items }`, or `{ count, queries }` with
`detail: "queries"` for a large match. Put those exact `queries` into the
`fillet.edges` or `chamfer.edges` list. Useful selectors for the committed
cases:

- the four vertical edges of an extrusion: `{"kind":"edge","where":{"and":[{"type":"line"},{"parallel":[0,0,1]}]}}`
- one outer vertical corner edge: the same and-chain plus the two extremes that
  leave that corner, e.g. `{"kind":"edge","where":{"and":[{"type":"line"},{"parallel":[0,0,1]},{"extreme":{"axis":"x","side":"min"}},{"extreme":{"axis":"y","side":"min"}}]}}`;
  four such chains under `or` name all four corners in one call
- the top rim of a cylinder: `{"kind":"edge","where":{"and":[{"type":"circle"},{"extreme":{"axis":[0,0,1],"side":"max"}}]}}`
- a face for `on_face`: `{"kind":"face","where":{"extreme":{"axis":[0,0,1],"side":"max"}}}`

The selector is only an authoring aid; its query output is what the document
stores, exactly as if each element had been clicked. Write the recipe by hand
from the returned queries. Committed recipes follow the sketch constraint law:
dimension the sketch and anchor it to projected geometry or the origin, so the
design is a model rather than a pile of coordinates. The source's coordinates
pick the dimension values; an example is a guide, not a 1:1 port.

A source `shell(kind="arc")` (CadQuery's default) or `offset(..., kind=Kind.ARC)`
(build123d's default) maps to `join: "arc"`; `kind="intersection"` maps to the
sharp default.

## 3. Compare and iterate

The runner emits CadQuery's own frame (XY plane, extrusion along +Z), and
`compare` does not rotate a reference: it measures the recipe in Oversolved's
Y-up world and compares the numbers unchanged. Map the source frame before
comparing. CadQuery's XY extrusion along +Z is Oversolved's Front plane, and a
box centred on CadQuery's origin needs a symmetric or re-origined extrusion so
its bbox and centroid land where the recipe does.

The source's world coordinates are used unchanged, so each named source plane
lands on one seeded plane with a fixed sketch-coordinate swap. CadQuery and
build123d define `XY`, `XZ` and `YZ` the same way (normal, then local x and y):

| Source plane | Source normal, x, y | Oversolved plane | Sketch point for source (u, v) | Extrude along source normal | Workplane offset d |
| --- | --- | --- | --- | --- | --- |
| `XY` | +Z, +X, +Y | Front (+Z, x +X, y +Y) | (u, v) | `direction: normal` | Front offset +d |
| `XZ` | -Y, +X, +Z | Top (+Y, x +X, y -Z) | (u, -v) | `direction: reverse` | Top offset -d |
| `YZ` | +X, +Y, +Z | Right (+X, x -Z, y +Y) | (-v, u) | `direction: normal` | Right offset +d |

So `Plane.XZ` (normal -Y, local y +Z) is the Top plane flipped: negate the
sketch y, extrude with `direction: reverse`, and negate an offset. A centroid or bbox row that
fails while volume and area pass is the expected sign of a frame mismatch; the
row says so, and it is not a geometry difference.

CadQuery's `extrude(..., taper=)` and build123d's `extrude(amount, taper=)` map
one-to-one to `extrude.taper`: the number is degrees, positive narrows along the
extrusion direction and negative widens it. Oversolved applies the same draft to
every lateral wall, holes included, so a washer's hole wall leans the opposite
way from its outer wall. The angle is refused with `termination: up_to`, `up_to_next` or
`through_all` and with `direction: symmetric`; a taper that collapses the
profile before the distance is refused with the height it would collapse at. A
taper whose angle closes the profile exactly at the distance builds to an apex
(a pyramid, a cone) rather than being refused; one that closes to a ridge (a
non-square rectangle) is refused by name.

CadQuery `Workplane.until` / build123d `Until.NEXT` maps to
`termination: up_to_next`; `until=` a face maps to `termination: up_to` with
that face as `up_to` (a curved face is accepted). A build123d extrude with
`mode=Mode.ADD` at a curved surface plus a signed offset maps to `up_to` (or
`up_to_next`), `up_to_start: surface` and `up_to_offset`.

Measure the recipe against the reference over MCP:

```jsonc
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"compare","arguments":{
  "docHash":"<docHash from the last run>",
  "reference":"<the reference.json object>"
}}}
```

Or from `frontend/`, directly on the files:

```bash
npm run drive -- compare ../frontend/translations/02-box-fillet-vertical/recipe.yaml \
    ../frontend/translations/02-box-fillet-vertical/reference.json
```

The result is `{ ok, pass, rows, measures }`. A failing row is data, not an
error: `rows[].delta` says which measure moved and by how much. `bodies`,
`volume`, `area`, `centroid` and `bbox` are always enforced; `faces` and `edges`
are reported unless the case sets `topology: strict`.

Fix the recipe when a measure disagrees beyond integration noise. Do not widen
the tolerance to hide a geometry difference; another kernel may split faces
differently, but the same kernel family should agree on the measures. If a case
genuinely cannot be expressed, report it rather than deleting it.

## 4. Commit the case

Keep `source.py`, `recipe.yaml` and `reference.json` together. The reference is
frozen truth for the frontend gate, which builds every case through
`measureLocally` and compares with `compareMeasures`; CadQuery is needed only
when the reference is regenerated. Run `just frontend` before committing.
