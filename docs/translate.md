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
`part`). Then run the reference runner:

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
node --experimental-strip-types --loader=./scripts/driveCli.loader.mjs scripts/mcpServer.ts
```

`run` takes mutation steps and returns a `docHash`; chain the next call with
that handle rather than re-sending the document. `select` takes the handle and
returns the query strings a click would store:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run","arguments":{"steps":[
  {"mutation":{"type":"add_sketch","featureId":"sk1","plane":"@builtin_plane_front"}},
  {"mutation":{"type":"add_rect","featureId":"sk1","p0":[0,0],"p1":[20,14]}},
  {"mutation":{"type":"add_extrude","featureId":"ex1","sketchQuery":"$sk1","distance":10}}
]}}}
// result.docHash is the handle for call 2.
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select","arguments":{
  "docHash":"<docHash from call 1>",
  "selector":{"kind":"edge","where":{"and":[{"type":"line"},{"parallel":[0,0,1]}]}}
}}}
```

`select` returns `{ queries, items }`. Put those exact `queries` into the
`fillet.edges` or `chamfer.edges` list. Useful selectors for the committed
cases:

- the four vertical edges of an extrusion: `{"kind":"edge","where":{"and":[{"type":"line"},{"parallel":[0,0,1]}]}}`
- the top rim of a cylinder: `{"kind":"edge","where":{"and":[{"type":"circle"},{"extreme":{"axis":[0,0,1],"side":"max"}}]}}`
- a face for `on_face`: `{"kind":"face","where":{"extreme":{"axis":[0,0,1],"side":"max"}}}`

The selector is only an authoring aid; its query output is what the document
stores, exactly as if each element had been clicked. Write the recipe by hand
from the returned queries. The committed recipes use exact initial sketch
geometry with no constraints: the translation is a direct model, not a
dimensioned design.

## 3. Compare and iterate

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
