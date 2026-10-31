# Drive Surface, Journal and Headless CLI

Three surfaces make the running app driveable from outside, all built on the
same command set:

- the dev bridge, `window.__oversolved`, installed by the part editor in
  development and test builds;
- the mutation journal, a ring of doc-changing mutation applies recorded at
  the session seam, which a repro downloads and a replay reproduces;
- the headless CLI, which runs the same scripts and replays journals through
  the real kernel in node, with no browser at all.

The source lives in `frontend/src/drive/` (bridge, script runner, journal,
replay, seeded ids, headless session) and `frontend/scripts/driveCli.ts` (CLI).

## Gating and installation

`Part.tsx` installs the bridge only when `DRIVE_ENABLED` is true
(`frontend/src/drive/gate.ts`):

```ts
export const DRIVE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test'
```

The expression is evaluated once at module scope and the guarded site
references the constant directly. In a production build Vite folds
`import.meta.env.DEV` to `false` and `import.meta.env.MODE` to `"production"`,
so the initializer becomes `false || "production" === "test"`, which the
minifier folds to `false`, dropping the installer and `driveSurface.ts`.
Verified on `frontend/dist`: `__oversolved` does not appear in the bundle.
Routing the check through a function defeats the fold (a call is not a
constant), which is why the guarded site reads the constant. The install
returns an uninstall that clears the global only while it still holds that
same surface, so a remount cannot delete a newer bridge.

The session journal sink is deliberately not gated: `Part.tsx` attaches it in
every build, because the recovery autosave borrows the journal's replayable
tail for the recovery journal and the crash reports. A production bundle
therefore carries `frontend/src/drive/journal.ts` (and the `oversolved-repro`
payload kind) while the bridge itself stays absent.

The bridge is installed by the part editor (the assembly editor has none in
v1). The journal is not wired to the registry: recording sits at the
`DocSession` mutation seam, so every user doc change the session applies is
recorded whether it came from a command, a tool, a drag gesture or a script,
and the solver write-back (which never goes through the session) is not.

## Bridge methods

All methods are JSON-safe in both directions and every failure is a Result,
never a thrown exception crossing the bridge.

| Method | Arguments | Returns |
|---|---|---|
| `commands()` | none | `{ id, label, shortcut?, enabled: true \| reason }[]` for the live spec table |
| `execute(id, params?)` | command id, raw params | the registry `Result` (`ok` + `createdIds`, or `code`/`message`) |
| `script(steps)` | step array (below) | `{ ok, steps: [{ index, kind, id, ok, createdIds, constraints?, error? }] }` |
| `inspect()` | none | session, editor and probe facts (below) |
| `idle()` | none | resolves when no solve is pending or running |
| `hitTest(x, y, opts?)` | CSS pixels, optional window size and layer list | ordered `ProbeHit[]` |
| `handles(prefix?)` | optional handle-id prefix | `ProbeHandle[]` (GL pickables plus DOM handles) |
| `worldToScreen(points)` | world points | `[x, y] \| null` per point, CSS pixels |
| `screenshot()` | none | PNG data URL from `captureScreenshotForSaving`, or null |
| `journal()` | none | the recorded journal entries |
| `repro()` | none | the repro payload, or null while the journal is empty |
| `downloadRepro(filename?)` | optional filename | `{ ok, filename, bytes }` or an error Result |

A command body that throws is caught at the bridge and returned as
`{ ok: false, code: 'bridge-error', message }`; the same guard covers mutation
steps. `idle()` is the doc-session idle, which resolves when the scheduler has
no pending or running solve.

## `inspect()`

One readout, three sections:

```jsonc
{
  "session": {
    "docId": "doc-1",
    "dirty": false,
    "featureCount": 2,
    "rollback": null,
    "editingFeatureId": null,
    "history": { "undo": ["..."], "redo": [] },
    "transactions": [{ "id": "...", "kind": "..." }],
    "solve": { "generation": 3, "pending": false, "running": false, "lastError": null },
    "validation": { "level": 2, "passed": true } | null,
    "bodies": { "count": 1, "ids": ["..."] } | null
  },
  "editor": {
    "normalSelection": ["..."],
    "hoveredSelectionId": null,
    "hoveredVertexId": null,
    "activeTool": "rect",
    "activeFeatureId": null,
    "editingFeatureId": null,
    "rollbackPosition": null,
    "drawPointCount": 0,
    "dimensionPickCount": 0,
    "activePickField": null
  },
  "probe": {
    "revision": 12,
    "canvas": { "width": 800, "height": 600 },
    "camera": { "position": [], "orientation": [], "zoom": 1, "projectionMatrix": [] },
    "pickableCount": 4,
    "handleCount": 4
  }
}
```

- `session` summarizes `DocSession.inspect()`; mesh payloads are reduced to
  counts, so the readout stays small and JSON-safe.
- `editor` is the live `stores/editorState.ts` subset.
- `probe` comes from `getSceneProbe()` (revision, camera, canvas, pickables)
  and `getSceneHandles()` (handle count) in `frontend/src/picking/`; the
  handles themselves stay behind `handles(prefix?)`.

## Script format

A script is an array (or `{ steps: [...] }`) of steps:

```json
{
  "steps": [
    { "command": "set_tool_rect" },
    { "command": "undo", "continueOnError": true },
    { "mutation": { "type": "add_sketch", "featureId": "sk1", "label": "Rectangle" } },
    { "mutation": { "type": "add_rect", "featureId": "sk1", "p0": [0, 0], "p1": [10, 10] } }
  ]
}
```

- A `command` step runs through the command registry; a `mutation` step runs
  through the session, the deterministic authoring path where ids are explicit.
- Steps run in order and each Result is recorded; the first failure stops the
  run unless that step sets `continueOnError`.
- The caller's settle function (the session idle) runs after every executed
  step, so awaiting the script also awaits the solves it started.
- `frontend/src/drive/scriptRunner.ts` is the one runner: the bridge and the
  CLI both call `runScript`, so the semantics cannot drift.

## Journal and repro replay

The journal is a ring (capacity 500) of entries recorded at the `DocSession`
mutation seam (`frontend/src/drive/journal.ts`, attached through
`DocSessionDeps.journal`; `usePartDoc` wires it from the part page in every
build, because the recovery autosave reads the tail):

```ts
{ kind: 'mutation' | 'batch', payload: Mutation | Mutation[], label?: string,
  docHashBefore: string, docHashAfter: string, mintIndex: number,
  unsettled?: true, at: number }
```

- The session reports each apply it lands with the docs as they stood before
  and after, synchronously inside the apply and before any solve can write
  back; the sink hashes them there. That is what makes drawing and gestures
  (which dispatch mutations without a command) journaled, and what keeps the
  solver write-back out (it never goes through the session). A no-op apply
  (hashes equal) records nothing.
- An apply that lands while a solve is pending or running is marked
  `unsettled: true`: the live doc is still authored at that moment, so a
  replay (which settles each step) reaches a baked state this entry cannot
  chain onto.
- A doc change no mutation can replay restarts the journal: undo/redo and a
  cancelled preview, gesture or edit session clear the ring, and the next
  entry captures its own baseline. A document switch clears it too, and each
  record carries its `docId`, so a journal can never span two documents.
- When the ring fills, it restarts as a new generation with the incoming
  apply as its first entry: what remains is always a contiguous, replayable
  suffix with a matching baseline.
- `docHashOf` is the one canonical document hash: `stableJson` (the checkpoint
  serializer from `frontend/src/kernel/builderHash.ts`) hashed with
  `sha256Hex`. The dirty fingerprint over saved YAML text
  (`frontend/src/session/dirty.ts`) is a different mechanism on the save path.

`repro()` returns the payload `downloadRepro` writes:

```jsonc
{
  "kind": "oversolved-repro",
  "version": 1,
  "docHash": "sha256 of doc",
  "doc": { /* the baseline document */ },
  "seed": 1875250360,
  "warnings": [ "entry 1 (add extrude ex1): applied while a solve was pending; ..." ],
  "journal": [ /* entries */ ]
}
```

`warnings` names every unsettled entry (index plus label or mutation type).
It is empty for a settled recording.

`replayJournal` (`frontend/src/drive/replay.ts`) reproduces a repro on a fresh
session: it checks the baseline hash first, then for every entry checks the
running doc against `docHashBefore`, seeks the id source to `mintIndex`,
applies the mutation (a batch through `executeGroup`), hashes synchronously
right after the apply and compares with `docHashAfter`, and only then settles
the step's solve. Hashing before the settle is what makes record and replay
compare the same authored pre-write-back state. A failed apply or a diverged
hash stops the replay and reports both hashes; a `mintIndex` that is not a
finite in-range integer is rejected with an `invalid-mint-index` step failure
rather than seeking forever.

Replay is guaranteed when every entry was settled:

- Every CLI and script recording is settled by construction (each step waits
  for its solve before the next), and so is any edit that waited for its
  solve.
- A repro containing unsettled entries fails loudly at the first divergence:
  the before-hash check reports the expected and actual hashes and stops. That
  boundary is the documented limit, not silent corruption, and the payload's
  `warnings` names the entries before replay is attempted.

The seed travels in the payload (`frontend/src/drive/seededIds.ts`):

- Each generation opens an id source under a recorded seed: the browser draws
  the seed from crypto once per generation (and per document reset), the drive
  CLI and the MCP `run` derive it from the starting document's content hash
  (`driveSeedFor`), so a repeat of the same document and script is
  byte-identical while a call chained onto the previous reply (a different
  starting document) draws a different sequence. `randomId` and every mint site
  that routes through it (`uniqueConstraintId`, `freshEntityIds`, `mintEntityId`
  in `frontend/src/utils/yamlMutations/helpers.ts`) mint under that source, so
  an id a handler mints internally (`add_rect`, `add_ngon`, a fresh constraint
  id) is a function of the seed and the source position.
- A minted id the starting document already carries is skipped and the next one
  drawn: the session installs the document's ids as a mint scope around each
  apply, so even a restarted or colliding sequence cannot add a second entity
  with an id the document already holds. `createdIds` then names what the apply
  really created.
- Replay installs the recorded seed and seeks each entry's `mintIndex`, the
  source position the apply started from. That covers ids minted outside the
  session (UI feature ids) that advanced the source without being replayed,
  and mutations with embedded ids, which replay applies verbatim.

### Journal versus crash recovery

The journal is deliberately kept beside the workspace recovery mechanic, not
inside it:

- `frontend/src/stores/recoveryStore.ts` owns crash-at-restart: the U7 prompt
  over the `workingRev`/`savedRev` pair in `workspace/store.ts`. It asks
  whether to keep (adopt) or discard the working copy and writes nothing until
  the user answers. It answers "adopt or discard the working copy".
- The command journal owns mutation-level reproduction. It answers "here is
  the exact mutation sequence that produced this document".
- The recovery journal (`frontend/src/recovery/journal.ts` plus
  `recovery/autosave.ts`) is the autosave shadow copy: one row per document
  uuid holding the live doc and the command journal's repro tail, written
  debounced after each session change and cleared by an explicit save. The
  open-time offer (`recovery/offer.ts`) compares its hash against the stored
  bytes, and an accepted restore is adopted in memory only, so a recovery path
  never writes the working copy.
- Local crash reports (`frontend/src/recovery/crashReports.ts`) record stack,
  build identity, the live doc snapshot and the same repro tail; the
  `/docs/crash-reports` page lists them and exports one as a zip, so a bug
  report carries a replay.

The workspace prompt shares no state with any of these. The recovery journal
and the crash reports both read the command journal's repro tail, and the
replay helper (`recovery/__tests__/replayReport.ts`) rebuilds a report through
`drive/replay.ts`, so a crash report and a repro download reproduce the same
way.

## Headless CLI

The CLI runs beside `frontend/scripts/regenCorpus.ts` with the same
`--experimental-strip-types` recipe, plus a loader shim for `import.meta.env`.
Its operations (run, measure, compare, export) live in
`frontend/src/drive/headlessOps.ts` and are shared with the MCP server (which
adds `select`, a predicate selector over the solve output), so the two external
surfaces cannot drift:

```bash
cd frontend
npm run drive -- run script.json [--doc doc.yaml] [--out tmp/doc.(yaml|json)] [--repro tmp/repro.json] [--file id=path] [--doc-id id]
npm run drive -- commands
npm run drive -- measure doc.yaml [--file id=path]
npm run drive -- compare doc.yaml reference.json [--file id=path] [--doc-id id]
npm run drive -- export doc.yaml --format step|stl [--out tmp/out.step] [--body bodyId] [--file id=path]
npm run drive -- replay repro.json
```

- Every command prints one JSON object on stdout; the kernel's own prints
  (OCC's STEP transfer banner) go to stderr, so stdout parses whole.
- `run` builds a document from mutation steps and/or command steps through one
  `DocSession` and the real kernel, optionally writes the final document (`--out`)
  and the journal (`--repro`), and prints steps, document hash, solve state, the
  feature problems (`features`, see the MCP section) and the resolved sketch and
  plane `frames` (also described there). The `--out` format is
  chosen by the extension: `.json` writes JSON, anything else writes YAML. The
  `--out` path must resolve inside the project's `tmp/` or `bugreports/`
  (relative paths resolve against the repo root, not `frontend/`). `--repro`
  follows the same rule. Both are checked before the script runs, so a refused
  path writes nothing, and both create a missing parent directory at write time.
  An empty script still solves the given document once and prints the same
  fields, so `run` doubles as the "inspect this document" call. Its journal
  derives every generation seed from the starting document's hash, so two runs
  of one script on one document produce byte-identical documents and the
  recorded repro replays exactly (the `cliSmoke` suite runs the box script
  twice in two processes and compares the printed `docHash`).
- `commands` prints the command catalog: every spec id, label, shortcut,
  `undoable` flag, its param fields (`spec.params.fields`, the same schema the
  registry parses a call against) and the live `enabled` verdict from a fresh
  seeded session. Reading the catalog runs no spec body and starts no solve.
  The catalog is the part editor's table (`PART_COMMAND_SPECS`); the MCP
  `commands` tool takes `kind: "assembly"` for the assembly editor's table
  (`ASSEMBLY_COMMAND_SPECS`).
- `measure` reports a `MeasureRecord`: `bodies`, `volume`, `area`, `centroid`
  (volume-weighted), `bbox` (a tight six-number box,
  `[xmin, ymin, zmin, xmax, ymax, zmax]`, computed from the faces so a trim that
  leaves a face's parameter rectangle whole cannot inflate it), plus face, edge
  and vertex counts from the final checkpoint's bodies. `perBody` adds one
  entry per live body (`id`, `volume`, `area`, `centroid`, `bbox`), in the
  solve's body order; its volumes and areas sum to the totals and its ids are
  the ids `run` and `select` use. The same `features`
  problem list `run` returns rides along (measuring builds every feature, so the
  kernel's verdicts are already known), and so does the `frames` map; a feature
  with no verdict makes `ok` false, exactly as it does for `run`.
- `compare` measures the document and compares it against a `reference.json`
  (the translation format: `source`, a required `tolerance`, an optional
  `topology` mode and the measure fields) with `compareMeasures`. It prints
  `{ ok, pass, rows, measures }`, one row per measure with `ours`, `theirs`,
  `delta`, `within` and `enforced`; exit 0 on pass, 1 on a failing row (or a
  build or kernel error), 2 on a usage error. A failing row is data, not an
  error: `ok` stays true so an agent loop reads which measure diverged. A
  document the settle could not answer for (a missing verdict) is `ok: false`
  instead, because comparing its empty measure to a reference would be
  meaningless.
- `export` writes STEP or STL bytes to `--out` (default `tmp/out.<format>`),
  creating a missing parent directory.
- `replay` applies the recorded mutations to a fresh session under the
  payload's seed, verifies each step's before and after hash and exits nonzero
  on divergence.
- `--file <id>=<path>` (repeatable) supplies the bytes for an `import_step`
  feature's `file_id`, the same map the browser's file registry hands the
  worker. A STEP file exported by `export` can therefore be re-imported and
  measured, which the `cliSmoke` suite does end to end. The byte map does not
  travel in the repro payload, so a journal containing an import replays only
  with `--file` supplied.

One session per process is the v1 contract: `solveLocally` keeps its
cross-solve checkpoint cache as single-writer module state, so two sessions in
one process would interleave their caches. Run two processes instead of
isolating the kernel globals. Command-driven adds mint deterministic
`<kind>_<n>` ids from a per-session counter; mutation steps pass explicit
entity/feature ids where the handler accepts one, and the seeded source covers
the handlers that mint internally. `delete_selected` is refused headlessly
(an `unsupported` Result) rather than reporting an ok that deleted nothing;
use mutation steps instead.

When OCC.js or the nodejs Rust solver build is absent, the CLI reports the
solver as unavailable and exits nonzero rather than guessing. A WASM trap is
different: the OCC module and the cross-solve cache are discarded and the solve
is retried once on a fresh module. A second trap in the same call fails it with
`kernel fault: <message>; the kernel was reloaded`, so a corrupt heap is never
reused for later calls.

## MCP Server

`frontend/scripts/mcpServer.ts` serves the same headless surface over the MCP
stdio transport (newline-delimited JSON-RPC 2.0), hand-rolled with no SDK
dependency. `initialize`, `tools/list`, `tools/call`, `resources/list` and
`resources/read` live in
`frontend/src/drive/mcpServer.ts`; the tool ops call the same `headlessOps.ts`
functions the CLI does. Point an MCP client at it directly (`cwd` is
`frontend/`):

```json
{
  "command": "node",
  "args": ["--experimental-strip-types", "--loader=./scripts/driveCli.loader.mjs", "scripts/mcpServer.ts"],
  "cwd": "frontend"
}
```

`npm run mcp` runs the same entry for manual poking, but npm prints its own
banner on stdout, so a client config must use the direct node invocation.

| Tool | Arguments | Returns |
|---|---|---|
| `commands` | optional `kind` (`part` default, or `assembly`) | the command catalog for that editor |
| `mutations` | optional `kind` (`part` or `assembly`), optional `family` (`sketch`, `features`, `picks`, `part style`, `document`, `parts`, `mates`) | the mutation vocabularies grouped by family plus ready-to-run example scripts; no argument returns both whole (about 90 kB), a filter returns only that slice and an unknown family is refused with the valid list |
| `run` | `steps`, optional `doc` or `docHash`, `kind` (fresh only), `parts`, `returnDoc`, `featureDeltas: "all"`, `out`, `detail` (assembly), `docId`, `files` | part: `{ ok, steps, docHash, solve, features, featureDeltas, frames, summary, doc?, file?, format? }`; assembly: `{ ok, kind: "assembly", steps, docHash, solve, mates, parts, instances, mateFrames, summary, doc?, file?, format? }` |
| `measure` | `doc` or `docHash`, optional `parts`, `detail` (assembly), `docId`, `files` | part: the `MeasureRecord` plus `features`/`frames`; assembly: `{ ok, kind, docHash, ...MeasureRecord, instances, solve, mates, parts }` |
| `compare` | `doc` or `docHash`, optional `parts`, `reference` (inline) or `referencePath`, optional `docId`, `files` | `{ ok, docHash, pass, rows, measures }`; a failing row is data, not an MCP error |
| `export` | `doc` or `docHash`, optional `parts`, `format` (step/stl), `out`, optional `body`, `docId`, `files` | writes the file, returns `{ ok, docHash, file, format, bytes }` |
| `select` | `doc` or `docHash`, `selector`, optional `docId`, `files` | `{ ok, docHash, queries, items }`: the query strings a click would store, plus a geometry summary per item; part documents only |

- `select` runs a predicate over the solved bodies and returns the exact query
  strings a click would store, so a headless author (an LLM, a translator, the
  fuzzer) can pick a fillet/chamfer/hole target without a pointer. The selector
  is a structured language modeled on CadQuery's string selectors: `kind` is
  `edge`, `face` or `vertex` (a vertex candidate is a body corner: the position
  predicates test the vertex's own point, its `type` vocabulary is just
  `vertex`, and a direction or radius clause matches none of them; the AND of
  three `extreme` clauses names one corner, the workplane-on-a-vertex idiom);
  `where` is one predicate, and several are composed with
  `and`/`or`/`not` (each predicate object carries exactly one key; two keys
  side by side are refused with the `and` form to use), over `parallel`,
  `perpendicular`, `type`, `extreme` (the min/max-projection group, tolerance
  grouped so a box top yields all four edges), `within` (the element's whole
  bounding box inside a world-axis range; `{"within":{"axis":"z","min":10,
  "max":20}}` names the edges between z=10 and z=20, and a missing `min` or
  `max` is open on that side), `center` (the point `extreme` projects: a line's
  midpoint, a circle, arc or ellipse's conic centre, a spline's middle sample or
  a face centroid, either within a distance of a world point
  (`{"center":{"point":[5,0,0],"radius":0.5}}`; the measure tolerance is always
  added to the radius, so 0.5 is effectively 0.500001, and omitting it leaves
  the tolerance alone) or inside a world-axis range on that point
  (`{"center":{"axis":"z","at":0}}` or `{"center":{"axis":"z","min":10,"max":20}}`;
  `at` is sugar for min = max = at), `on_face` (edges bounding the
  selected faces), `created_by` (ancestry through the query engine) and
  `radius`. A multi-key example:
  `{"and":[{"type":"line"},{"parallel":[0,1,0]}]}`. `extreme.axis` is a world
  vector; the letters `"x"`, `"y"` and `"z"`
  are sugar for the unit axis, and an invalid axis repeats the whole clause
  (`{"extreme":{"axis":"up","side":"max"}}`) in the error. Omitting `where`
  takes every candidate, so `{from:"body_ex1",kind:"edge"}` is all edges of one
  body. An edge direction test reads the edge's own tangent, not its
  underlying curve's axis: a line's direction, an arc or partial ellipse's
  tangent at the middle of its sweep, a spline's tangent at its middle sample.
  A full circle has no single tangent, so no `parallel`/`perpendicular` clause
  matches it; select it by `type` and `radius`. This is what makes a filleted
  plate behave: the fillet's boundary arcs are swept in an XZ plane, so they do
  not match `parallel: [0,1,0]` even though their circle's axis is Y, while the
  straight Y edges (the fillet's tangent boundary edges included) still do. A
  seam edge is the face meeting itself, not a boundary between two faces, so it
  has no direction to compare and matches neither `parallel` nor
  `perpendicular`; the other predicates still return it and a click can pick it.
  On a flat
  face `parallel` tests the normal; on a curved analytic face (cylinder, cone,
  torus) it tests the analytic axis from `surface_frame`, not the radial normal,
  so `parallel: [0,1,0]` names a Y-axis cylinder rather than one of its seams. A
  `type` is one exact spelling per meaning, with no synonyms: an edge kind
  (`line`, `circle`, `arc`, `spline`, `ellipse`) or a face surface type
  (`flatface`, `cylinderface`, `coneface`, `sphereface`, `torusface`). A
  `type` name outside the kind's vocabulary is refused as an invalid argument
  with the valid list and the likely spelling (`plane` suggests `flatface`),
  including inside a `not`, where it would otherwise match everything. An empty
  match is a tool error whose message names the
  nearest-miss count per predicate. In an `and` the counts are sequential: the
  first clause reads "matched N" over every candidate, each later one reads
  "then ... left M of N", counted against what the earlier clauses kept, not
  over the whole pool. When a `type` clause matched nothing it also
  lists the values present among the candidates and the full valid set for that
  kind. An unknown predicate key is an invalid
  argument rejected by name. The selector itself is an authoring aid and is
  never stored: the returned queries are what goes into the document, exactly
  as if each element had been clicked. The engine is pure TS in
  `frontend/src/kernel/select/`.

  To name one outer vertical corner edge of a plate, chain the direction and
  kind with the two extremes that leave the corner. Each `extreme` groups what
  the earlier clauses left, so on a Y-up plate:

  ```jsonc
  {"kind":"edge","where":{"and":[
    {"parallel":[0,1,0]},{"type":"line"},
    {"extreme":{"axis":"x","side":"min"}},{"extreme":{"axis":"z","side":"min"}}]}}
  ```

  Four such chains under one `or` name all four corners in a single call. There
  is no outer-boundary or `length` predicate; this is the recipe.

- Document handles: every tool that needs a document takes exactly one of
  `doc` (the full JSON) or `docHash` (the content hash an earlier reply
  returned). `run` is the exception: it may take neither, which starts from a
  fresh seeded document, but not both. Passing both or neither where exactly
  one is required is invalid params. The server keeps the last 256 documents
  in-process, content-addressed and recency-refreshed on a hit, so a hash that a
  client keeps chaining on is not the eviction victim when another client's
  calls interleave; an unknown
  hash is a tool error naming that bound, with "pass doc instead". A document
  passed as `doc` is stored too, so a hand-edited part gets a handle; the
  reply's `docHash` names that stored content, so `select`, `measure`,
  `compare` and `export` all echo it.
- By default `run` returns `docHash` and a one-line `summary` (feature ids and
  kinds, body ids), not the document; `returnDoc: true` adds the full `doc`
  for saving or hand-editing. The summary's body ids are the live bodies of the
  final solve, not the accumulated `part_style` keys: a boolean or join consumes
  a body while its colour entry stays behind, and the reply must not name what
  the measure tool no longer counts. When a step is refused no final solve runs,
  so the summary says `bodies: not solved (step N refused)` instead of falling
  back to `part_style`. Chaining by hash is the intended flow: a
  modelling session does not re-send the part on every call.
- The full document behind any reply's `docHash` is also a resource:
  `resources/templates/list` advertises `oversolved://doc/{docHash}`, and
  `resources/read` on `oversolved://doc/<hash>` returns the document as JSON.
  That is the out-of-band path for the large case (a few n-gon sketches already
  run to about 1500 lines pretty-printed), so `run` never has to inflate every
  reply with bytes the caller may not need. An unknown or evicted hash is
  invalid params naming the 256-document bound.
- `ok` means the steps applied and the solve ran, not that every feature
  built. A feature can solve to `exception` or `partial`, or succeed with a
  `solver_warning` (a fallback, or a hole that removed nothing), and `ok`
  stays true: that is data like a failing compare row, not a failed call. The
  exception is a warning a later feature made moot: when a later union or merge
  fused the bodies a "the new solid also touches ..." warning named, the kernel
  moves that text to `resolved_warning` (exposed as `resolvedWarning` on the
  outcome) and the feature is not listed. The
  `features` list carries every such feature in feature log order as
  `{ id, kind, status, message }`, where `message` is the kernel's own
  exception or warning text; it is always present and empty for a clean build.
  The one-line `summary` repeats it as a `; problems: <id> (<kind>) <status>:
  <message>` suffix, so a client that reads only the summary still sees it.
  Sketch verdicts (`fully_constrained`, `underconstrained`) are normal states
  and are not listed; an `overconstrained` sketch is. A feature with no verdict
  at all after the settle is listed with status `missing` and message `no verdict
  from the solve`, and makes `ok` false: an empty solve result must never read
  as a clean build. A kernel fault (a WASM trap that repeated on the reloaded
  module) is also `ok: false`, with `solve.lastError` naming the fault.
  `featureDeltas` answers "what did this step contribute": one row per feature
  this call changed, in log order, with `id`, `kind`, `status`, the cumulative
  `volume` and `bbox` after it (the total over every live body, not one body's),
  and `volumeDelta`/`bboxDelta` from the previous checkpoint. A feature that
  built or changed one body also carries `body` (its id, e.g. the merge_target a
  cut went into) and `bodyVolume` (that body's own volume after it). A row
  appears when the feature's checkpoint differs from the input document's solve,
  when the feature is new, or when the steps touched a solid-producing feature
  (so an edit that leaves the same volume still shows its zero contribution);
  untouched planes and sketches from an earlier call do not repeat, and neither
  does an existing sketch or plane whose own delta is zero (an upstream edit
  moves its cumulative checkpoint, not its contribution). The first body's deltas start from zero. A failed, partial or
  warning feature
  has no row (its checkpoint may hold half-applied geometry), but that
  checkpoint still sets the baseline for the next clean feature, so a later
  delta describes the real part. Pass `featureDeltas: "all"` to list every clean
  feature, which is how an empty `steps: []` call inspects the whole history.
  The list is null when the final solve exposed
  no measurable checkpoints (the kernel was unavailable or faulted, which is
  also `ok: false` with `solve.lastError`). The checkpoint
  measurement reads each unique OCC shape once, not once per feature.
- `run` with `steps: []` solves the given `doc` or `docHash` once and returns
  the same fields. It is the "inspect this document" call: the solve state has
  a real `generation` and `features` is the document's problem list. A reply's
  `docHash` is stable: `run` with `steps: []` on it, by `docHash` or with its
  exported YAML or JSON as `doc`, returns the same hash. A loaded `doc` is
  stamped with the loader's current version, so a document an older stamp
  migrated on the way in does not migrate again on its next reload.
- `files` is `[{ id, path }]`, the CLI's `--file` flags in JSON form; paths
  resolve against the server's cwd.
- `run` with `out` writes the final document (even the accepted prefix of a
  refused script) as JSON for a `.json` path and YAML otherwise, and adds
  `file` and `format` to the reply. `compare` with `referencePath` reads the
  reference from a file instead of inline. `run`'s `out`, `export`'s `out` and
  `compare`'s `referencePath` all resolve relative paths against the repo root,
  so `tmp/x.json` names the project's tmp even though the server runs with cwd
  `frontend/`. A written document or export must stay inside `tmp/` or
  `bugreports/`; a reference may also come from `scratch/`. Anything else is
  refused with the allowed directories named. A missing parent directory is
  created at write time, so a fresh run directory needs no pre-making. The file
  reference goes through the same corpus validator as the inline object.
- `compare` takes its `reference` inline (the agent has just produced it) and
  validates it through the corpus parser, so a reference missing `tolerance`
  or carrying a malformed bbox is JSON-RPC invalid-params, not a tool error.
  The reference shape is the translation file format:

  ```jsonc
  {
    "source": { "tool": "cadquery", "version": "2.4.0", "file": "source.py" },
    "tolerance": { "rel": 1e-5, "abs": 1e-6 },
    "topology": "report",
    "bodies": 1, "volume": 800, "area": 720,
    "centroid": [5, 5, 4], "bbox": [0, 0, 0, 10, 10, 8]
  }
  ```

  `topology` is optional (`"report"` by default, `"strict"` to enforce the
  face/edge counts); `tolerance` is required so every reference states its own
  budget. The five measures `bodies`, `volume`, `area`, `centroid` and `bbox`
  are required as well, and the CadQuery runner
  (`frontend/scripts/cadqueryReference.py`) already emits all five, so a
  reference produced by another tool's exporter that omits `area` is refused
  naming the field rather than compared on a narrower set. The measures are
  top-level keys: nesting them under `measures` is refused with a message
  saying so, in the MCP tool and the CLI alike.
- `compare` compares the reference in Oversolved's world frame unchanged: it
  does not rotate another tool's coordinates. State the reference in Y-up.
  CadQuery's own frame is Z-up, so a CadQuery XY-plane extrusion along +Z is
  Oversolved's Front plane, and a box centred on CadQuery's origin needs a
  symmetric or re-origined extrusion before its bbox and centroid match. A
  centroid or bbox row that fails while volume and area pass carries the frame
  hint only when the Z-up to Y-up swap (`(x,y,z)` to `(x,z,-y)`) actually makes
  that row match; a positional miss the swap cannot explain reports just its
  axis delta.
- The server serves three fixed resources (`resources/list`,
  `resources/read`): `oversolved://schema/part-document`, the JSON Schema for a
  part document (`persistence/partDocSchema.ts`),
  `oversolved://schema/assembly-document` for an assembly
  (`persistence/assemblyDocSchema.ts`), and `oversolved://catalog/mutations`,
  the same JSON the `mutations` tool returns.
  A fourth, dynamic one is advertised through `resources/templates/list`:
  `oversolved://doc/{docHash}` reads back any document the server still holds,
  so a caller fetches the bytes on demand instead of asking `run` to return
  them. Read the schema before authoring a
  document instead of inferring the format from these examples; it pins the
  canonical spellings (feature refs are `@id`, params nest under the kind key).
- `mutations` is the discovery path for the script vocabulary: `commands` act
  on the current selection, while mutation steps author geometry with explicit
  feature and entity ids. Each visible entry carries its fields and a summary,
  and the examples are the box and fillet scripts the catalog tests run against
  the real kernel. The catalog is generated where it can be: `add_entity`
  lists the params slot order of every entity kind from the entity registry
  (`line [x1, y1, x2, y2]`, `circle [cx, cy, r]`,
  `arc [cx, cy, r, a0_deg, a1_deg]`, and so on, with arc and ellipse angles in
  degrees and arcs sweeping counter-clockwise), the `set_*_field` value note
  emits the enum members of every enum field in that kind's schema
  (`operation: add|cut|new`, `direction: normal|reverse|symmetric`,
  `termination: blind|up_to`, `operation: new|replace`), and `add_plane`'s
  `definition` carries the same shape the part-document schema serves (its
  `mode` enum includes `offset`, and the common offset plane is
  `{mode:"offset", plane:"@builtin_plane_top", offset:43}`). A multisection
  sweep is one `add_sweep_profile` per section and then
  `set_sweep_field {field:"multisection", value:true}`; every section must be
  pierced by the path.
  A `fit_spline`'s `params` are its flat fit points (`x0, y0, ..., xN-1, yN-1`,
  2..64 points). The optional `tangents` pair (`[start, end]`, each `[tx, ty]`
  or null) is converted to the stored absolute end handles (the first piece's
  second control point and the last piece's third); `tangentScale` defaults to
  true, CadQuery's `scale=True`, and applies OCCT's `ScaleTangents` once at
  authoring. With no tangents the ends take the Lagrange derivative, exactly
  like CadQuery. Mapping: CadQuery `spline(points, tangents, scale)` is
  `params: points`, `tangents`, `tangentScale: scale`. build123d's
  `Spline(*pts, tangents, tangent_scalars)` is believed to normalize the
  tangents, multiply by the scalars and interpolate with `scale=False`; that
  mapping is UNVERIFIED until a tea_cup/handle practice re-run confirms it.
  Guidance that a field list cannot carry lives in the row note: `hole` lists
  its required fields (`sketch`, `diameter`, `depth_mode`) and its optional ones
  (`depth`, `direction`, `target`, `thread`, `style`, `cb_diameter`, `cb_depth`,
  `cs_angle`), with `depth` required only for a blind hole because a
  `through_all` hole is sized by the target body and stores no depth; all are
  optional in an `add_hole` payload. An empty value clears the `target` pick, on
  the inline add and on `set_hole_field` alike (the hole then drills the body its
  drill sites sit on); every other field refuses an empty value rather than
  silently reverting to its default, and `null` clears an optional field; null
  on a required field would delete a key the loader needs. With no `target`
  the hole drills the body its drill sites sit on or in, so a face sketch
  whose sites lie on or in the material picks that body even when it is not
  the first; a site outside every body (a plane sketch in the air) falls back
  to the first body and the miss
  warning names it. `hole.direction` is `normal` (the sketch
  plane's normal, the default) or `reverse`; a face sketch's normal points out
  of its face, so a hole on a face usually wants `reverse`, and a blind hole
  that misses every site warns with that fix when the reverse would cut. A
  `through_all` hole drills one way from its plane and never cuts the material
  behind it. Under `normal` it finds the material side itself: the sites that
  have material on one side only vote, every site drills the winning side (a
  tie keeps `normal`), and a site that leaves material on the other side is
  named in a warning. `reverse` is obeyed as written at every site. The run
  reply's `featureDeltas` row carries the resolved `direction`.
  `hole.sketch` is spelled `@<sketchId>` (or a narrower
  viewport pick), not the profile consumers' `$<sketchId>` form, and a circle
  drills at its own radius while a point uses the feature `diameter`; a sketch
  whose drill sites are all circles never reads `diameter`, though the document
  still requires the field and a point site added later does use it;
  construction points and circles are skipped by a whole-sketch pick, and
  picking one alone is refused by name;
  `add_center_rect` takes the half-diagonal corner (center `[0,0]` with corner
  `[1,1]` is 2x2) and leaves a centre point entity; `add_rect` creates its line
  ids in bottom, right, top, left order; `add_revolve` takes the required
  `axis` inline (`@<sketchId>/<entityId>` or an edge query from `select`), and
  an axis that crosses a profile's interior is refused by name; `transform`
  applies scale first, then rotation, then translation, always about exactly
  one axis given either as `rotation_axis` (a ref) or as `rotation_axis_origin`
  plus `rotation_axis_direction`; `add_fillet` takes all of `edges` and
  `radius` in the same call; `add_shell` takes `faces`, `thickness` and
  `direction` in the same call, `thickness` is a positive magnitude with
  `direction` carrying the side, and its wall joins with sharp edges, so an
  outward shell of a sharp part keeps sharp outer corners where CadQuery's
  `shell()` (default `kind="arc"`) rounds them: `Ex017` measures 1.0405
  against CadQuery's 1.031678 on a 2 mm cube shelled 0.05 outward. The arc
  join here is only the fallback for a build the sharp join refuses;
  `add_split` takes `bodies`, `plane` and `keep` inline, `above` is the side the
  plane normal points to (a picked face's
  normal is outward, so `above` of a face pick is its air side), and with
  `keep: "both"` the above half keeps the original body id while every further
  piece becomes a `_1`, `_2` sibling in geometric order, so `@<featureId>`
  still names all of it; `toggle_construction` takes entity targets as
  `entity:<sketchId>:<entityId>` and `delete` takes entity, vertex or constraint
  refs (a bare id is refused); `mirror_entities` takes `sourceIds` as bare entity
  ids of one sketch plus `line`, the id of exactly one `line` entity of that same
  sketch (normal or construction) which is the axis and is never mirrored, and
  the mirrored copies are plain authored geometry, not a live mirror relation;
  `add_variable` must sit
  before every feature that names it, and `reorder_features` takes exactly one
  of `toIndex` (which counts the seeded plane rows), `before: <featureId>` or
  `after: <featureId>`, while `add_plane` takes `before` to insert in place;
  `delete_feature` removes only the named row, so a
  dependent stays in the log and reports its missing input; and an array's
  `operation: add` only fuses copies that touch, so disjoint copies split into
  bodies named with `_1`, `_2`... suffixes. The three array/mirror adds take
  their whole payload inline: `add_array` takes every linear-array field
  (`source_body`, `mode`, `operation`, `include_source`, `count_x`/`pitch_x`,
  `direction_x_query`, `invert_x`, and the rectangular `_y` siblings),
  `add_circular_array` takes `source_body`, `operation`, `include_source`,
  `count`, `step_angle`, `axis`/`axis_origin`/`axis_direction` and
  `invert_axis`, and `add_mirror` takes `body`, `plane`, `keep_original` and
  `merge`, so one call replaces the add plus one setter per field.
- A sketch is one profile, and a profile fills even/odd: a loop nested inside
  another is a hole (a disc plus a circle becomes a washer), while loops that
  CROSS each other are filled as their union. A circle meant as a hole that
  pokes past the rim of another loop therefore adds a bump where it crosses
  instead of cutting a notch, with no warning: `Ex007` measures 1.5036 against
  the 1.4726 of the same sketch with that hole inside the rim. Keep a cut loop
  inside its boundary, or cut with a separate sketch.
- Plane refs are exact. `add_sketch.plane`, `set_feature_plane.plane`,
  `add_split.plane` and `set_split_field` with `field: "plane"` accept
  `@builtin_plane_front`, `@builtin_plane_top`, `@builtin_plane_right`, the bare
  names `Front`/`Top`/`Right` (case-sensitive), `@<planeId>` for a plane
  feature, or a `?` face query from `select` (the stored `?...:flatface`
  string), so a face pick can place the sketch in one step (`add_split` and
  `set_split_field` take the flat-face form only; a curved face is refused). An
  unmatched NAME
  is refused with the valid list; a name never falls back to the XY plane. A
  face query is resolved after the solve, and a plane or face query that does
  not resolve fails the sketch with the cause named: a plane feature defined
  later in the log (the message names the one-step fix,
  `reorder_features {featureId: <planeId>, before: <sketchId>}`) or a face query
  nothing registers any more. Only an absent or empty query keeps Front.
  `add_sketch.plane` and `set_feature_plane.plane` also take the selector
  itself, `{selector: <a select selector naming exactly one face>}`: the
  headless drive resolves it against the settled solve and stores the query
  string it matched, so no `select` round trip or paste is needed. The same
  form is accepted per `add_shell.faces` entry, where a selector may expand to
  several faces; a selector is never stored.
- A sketch on a face uses that face's frame: origin at the face centroid, and
  the in-plane axes from the face normal by `normalToFrame` (the same rule
  every body face is registered with). For the six world-axis normals:

  | face normal | sketch x | sketch y |
  |---|---|---|
  | +Z | +Y | -X |
  | -Z | -Y | -X |
  | +Y | +X | -Z |
  | -Y | -X | -Z |
  | +X | -Y | -Z |
  | -X | +Y | -Z |

  For any other normal, sketch x is the normal crossed with world +Z (or with
  world +X when |n_z| >= 0.9), y is the normal crossed with x, both
  normalised. On a +Z or -Z face that is a quarter turn against the parallel
  builtin plane, so write sketch-local x along the world axis the table names,
  not the one the builtin plane's name suggests.
- Each `add_plane` mode builds its frame as follows, then an optional
  `rotation` turns x and y about the normal by that many degrees:
  - `offset`: the parent plane's axes and normal; origin is the parent origin
    plus `offset` times the normal.
  - `three_point`: origin p1; x from p1 to p2; y in the p1-p2-p3 plane
    perpendicular to x; normal is x cross y.
  - `plane_point`: the parent plane's axes and normal; origin is the parent
    origin plus the normal times the point's signed distance from the parent
    plane, so the point's in-plane offset is dropped.
  - `line_angle`: origin at the line's start; x along the line from start to
    end; y starts as world +Z projected off x (world +X when the line is
    nearly parallel to Z, |x_z| >= 0.9) and rotates by `angle` degrees towards
    x cross y0; normal is x cross y.
  - `on_face`: origin at the face centroid and the face normal; a
    `@<body>/face/<index>` pick keeps the face's own OCC axes, any other face
    ref takes them from `normalToFrame` (the table above).
  - `on_face_edge_angle`: origin at the face centroid, normal the face normal;
    x is the edge direction projected into the face and rotated by `angle`
    about the normal; y is normal cross x.
  - `edge_point`: origin at the point; x along the edge from start to end; y
    points from the point to its projection on the edge line, so the plane
    holds both the edge and the point; normal is x cross y. When the point
    lies on the edge, y comes from x crossed with world +Z (world +X when x is
    nearly parallel to Z).
  - `origin_rotation`: origin is the `origin` field (a point ref such as a
    selected vertex, or `[x, y, z]` world coordinates); the axes are the
    parent plane's axes (world XY when no `plane` is named) swung about
    `rotation_axis` (`x`, `y`, `z` or a `[x, y, z]` direction) by
    `rotation_angle` degrees, Rodrigues, with the normal rebuilt as x cross y.
    `rotation_axis` and `rotation_angle` are required together; the common
    in-plane `rotation` still applies last.
- Read the frame from the reply. Every `run` and `measure` reply carries
  `frames`, an object keyed by feature id whose entries are
  `{origin, x_axis, y_axis, normal}` for each sketch and `add_plane` feature
  the solve resolved (rounded to the document's 6 decimals). A suppressed
  feature or one whose solve threw (status `exception`) has no entry because
  it produced no frame-bearing result; an overconstrained sketch still reports
  the plane it solved on. `{origin, x_axis, y_axis, normal}` is world space,
  Y-up, in the same frame the document and `compare` use.
- A payload with `ok: false` comes back with the MCP `isError` flag. The
  JSON-RPC error channel is reserved for malformed requests and invalid
  arguments; unknown fields are rejected by name, so a typo never fails
  silently. That includes an inline `doc` (or a `parts` `{doc}`): after the
  load it is checked against the served part or assembly schema, so a
  misspelled key refuses with its path. The browser loader is deliberately
  tolerant of unknown keys, so a newer file still opens in an older build.
- `initialize` instructions and the `select` description carry one generated
  world-frame sentence (from `BUILTIN_PLANES`): Y is up, each builtin plane's
  normal and sketch axes, and that an extrude goes along the normal. It is
  generated rather than hand-typed so a plane change cannot leave it stale.
  `initialize` also carries the generated face-frame sentence (from
  `normalToFrame`), the +Z/-Z/+Y/-Y/+X/-X table above and the advice to read a
  feature's frame from the `frames` map.
- stdout carries protocol messages only: the entry redirects every other
  stdout write (the OCC STEP writer prints a transfer banner) to stderr.
- The readline loop processes one call at a time, and every `run` is a fresh
  `DocSession` over the real kernel with the drive journal installed under a
  seed derived from the starting document, so a repeated call on the same
  document mints the same ids and hashes the same document, while a call
  chained by `docHash` starts from a different document and cannot repeat the
  previous call's minted sequence. The loop's serialization is what keeps the
  kernel's single-writer cross-solve cache honest.

An agent session, entirely over MCP. Every call chains on `docHash` from the
previous reply; the full document never crosses the wire by default:

```jsonc
// 1. Build a 40 x 30 sketch on Top and extrude 10 along +Y.
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run","arguments":{"steps":[
  {"mutation":{"type":"add_sketch","featureId":"sk1","label":"Rectangle","plane":"@builtin_plane_top"}},
  {"mutation":{"type":"add_rect","featureId":"sk1","p0":[0,0],"p1":[40,30]}},
  {"mutation":{"type":"add_extrude","featureId":"ex1","label":"Extrude","sketchQuery":"$sk1","distance":10}}
]}}}
// {"ok":true,"docHash":"<hash1>","summary":"features: sk1 (sketch), ex1 (extrude); bodies: ...",...}
// 2. Pick the four Y-parallel edges (Y is up, so these are the 10 mm verticals).
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select","arguments":{
  "docHash":"<hash1>","selector":{"kind":"edge","where":{"parallel":[0,1,0]}}
}}}
// {"ok":true,"docHash":"<hash1>","queries":["?..."],"items":[...]}
// 3. Fillet those queries on the same handle: one call carries the whole pick.
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run","arguments":{
  "docHash":"<hash1>","steps":[
    {"mutation":{"type":"add_fillet","featureId":"fi1","label":"Fillet","edges":["?..."],"radius":3}}
  ]
}}}
// {"ok":true,"docHash":"<hash2>",...}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"measure","arguments":{"docHash":"<hash2>"}}}
// {"ok":true,"bodies":1,"volume":11922.743,...}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"compare","arguments":{
  "docHash":"<hash2>",
  "reference":{"source":{"tool":"hand","version":"1","file":"-"},
    "tolerance":{"rel":1e-4,"abs":0.01},
    "bodies":1,"volume":11922.743,"area":3733.044,
    "centroid":[20,5,-15],"bbox":[0,0,-30,40,10,0]}
}}}
// {"ok":true,"pass":true,"rows":[...],"measures":{...}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"export","arguments":{
  "docHash":"<hash2>","format":"step","out":"tmp/box.step"
}}}
```

When a caller needs the document itself (to save it, or to hand-edit it before
the next call), pass `"returnDoc": true` to `run` and send the returned `doc`
back in place of `docHash`.

`render_png` is deliberately not offered: the browser's raster path is the
three.js viewport (WebGL, DOM-bound) and the node tier has no offscreen
renderer, so a render tool would mean a new rasterizer rather than a reuse.

### Assemblies

An assembly is driven through the same tools. Bind each `part_instance.doc_id`
with the `parts` argument (`{ "<doc_id>": "<part docHash>" }`, or
`{ doc: <part document> }` to send it inline), then `run` with
`kind: "assembly"`:

```jsonc
{ "kind": "assembly",
  "parts": { "plate": "<plateHash>", "pin": "<pinHash>" },
  "steps": [
    { "mutation": { "type": "add_part", "handle": "plate", "part": "plate", "fixed": true } },
    { "mutation": { "type": "add_part", "handle": "pin", "part": "pin", "position": [30, 30, 40] } },
    { "mutation": { "type": "add_mate", "featureId": "m1", "kind": "fixed",
                    "ref_a": { "part": "plate", "selector": { "kind": "face", "where": { "and": [
                      { "type": "flatface" }, { "extreme": { "axis": [0,0,1], "side": "max" } } ] } } },
                    "ref_b": { "part": "pin", "selector": { "kind": "face", "where": { "and": [
                      { "type": "flatface" }, { "extreme": { "axis": [0,0,1], "side": "min" } } ] } } },
                    "capture": true,
                    "offset": 5 } }
  ] }
```

The pin is seeded roughly (it is still 40 mm in the air) and `capture: true`
freezes the contact the seeds imply, so no `flip` or `angle` is written by
hand. The served `pin_on_plate` example does both at once: it captures the
orientation and authors `offset: 5`, floating the pin's anchor 5 above the
plate's top face (the plus convention, below). A script that skips capture and
authors `flip: true` by hand is equally valid.

- `detail` trims an assembly `run` or `measure` reply to what changed (default
  `full`, today's reply). `summary` keeps `ok`, `docHash`, the solve verdict,
  dof and iterations, the mate and part problems and the one-line `summary`.
  `changed` adds, for `run`, the instances whose solved pose moved against the
  starting document's solve (a throwaway extra solve, paid only for this
  level), the mate frames of mates the call added or edited or that have a
  problem, `solve.mates` for problem mates only, and the refused steps whole
  (accepted ones collapse to `stepsAccepted`). `measure` has no starting
  document, so `changed` lists no instances there. A part document refuses
  `detail`. Under `summary` and `changed` the reply's `steps` key becomes
  `stepsAccepted` (a count) plus `steps` holding only the refused ones.
- `add_rect`, `add_center_rect` and `add_ngon` steps report `createdIds` as
  the entity ids in minting order (rect: bottom, right, top, left lines) plus
  `constraints: <count>`; the constraint ids stay readable from the document
  resource. Other mutations list every id they create.
- The reply's `docHash` is the assembly handle. It folds the assembly document
  and every bound part's content hash, so a chained `measure { "docHash": A1 }`
  needs no second argument, and a part edit yields a new handle. `parts` on a
  chained call overrides one binding and mints a new handle.
- A mate ref is a part-local pick: `{ part: <handle>, query: <a select query> }`,
  `{ part: <handle>, selector: <exactly one entity> }`, `{ part: <handle>,
  anchor: <anchor id> }`, or the assembly frame
  `{ part: "__assembly", anchor: "AssemblyTop" }`. Run `select` on the part's
  own docHash to get queries; the selector is an authoring aid and is never
  stored. A mate selector is validated exactly like the `select` tool's
  argument, so the `"x" | "y" | "z"` extreme-axis sugar works and a typo is
  refused with the same wording. Only `{ part, anchor, anchor_descriptor }`
  reaches the document.
- `flip` compares the two anchors' axes as `select` lists them (the `axis` of a
  circle item, the normal of a flat face, the analytic axis of a cylinder): for
  faces that is the outward normal, so `flip: true` is face-to-face contact
  between two outward normals; for circle edges it is the edge's own
  orientation, which depends on how the edge was made (an extruded hole's
  circle reads the same way on the top and on the bottom face). Absent means
  parallel axes and canonical zero roll.
- The recommended recipe is to place the parts roughly (`add_part`'s
  `position`/`rotation` are exactly the kind of pose the editor captures from)
  and pass `capture: true` on `add_mate` or `set_mate_ref`: once the refs
  resolve, the step measures `flip` and `angle` at the instance seeds, the same
  poses the solve starts from, and freezes them into the mate. The solve then
  holds the pose you seeded instead of one you found by trial solving, without
  having to learn each circle edge's axis direction from a failed solve first.
  An explicit `flip`/`angle` in the same step wins over the captured value,
  and the step result carries `captured: { flip, angle }` (angle only for the
  kinds that read a roll; plus `overridden: [...]` when an explicit value beat
  a captured one) so the reply says what was frozen into the document. The
  default is `capture: false`, so a document authored before this existed
  keeps its meaning, and a kind with no authored orientation (spherical,
  tangential, copy_rotation) captures nothing.
  Read the reply's `mateFrames` (each mate's posed anchors) to see which way an
  axis points at the solved pose.
- A mate `offset` is a number along A's anchor axis or a partial `{x, y, z}`
  in body A's local frame (it rotates with A). The sign reads "B's anchor
  sits at A's anchor PLUS the offset": the `add_mate` above with
  `"offset": 5` rests the pin's anchor 5 above the plate's top face (its
  outward normal), while a negative value sinks it into the plate.
  `parallel_plane_distance` reads the same value as the plane separation along
  A's normal, `tangential` as a surface clearance, and `sliding` refuses an
  offset (it would pin the joint's only translational DOF).
- Solved poses are never written back: each `instances[]` row carries
  `{ handle, part, fixed, position, rotation, quaternion }`, and the document
  keeps its authored seeds. A bake-flagged operation still bakes the last
  solve's transforms, as the editor does. `set_part_fixed` is one of them: its
  default bakes the pose on screen into the seed and reports
  `poseKept: "solved"`, while `bake: false` keeps the authored seed and reports
  `poseKept: "seed"`; pass it right after a solve you do not trust, so a
  diverged pose is never frozen into the document. A call whose first step is
  the toggle has no solve to bake yet, so it reports `poseKept: "seed"` too.
- `ok` means the steps applied and the final solve ran. A stale mate, a mate
  error, an overconstrained verdict, a part bundle that failed to build or a
  part feature in `exception` are data in `mates` / `parts` and the summary's
  `; problems:` suffix; `underconstrained` is a state (`solve.verdict`,
  `solve.dof`), not a problem. `not_converged` is a problem row too, but a
  different remedy: the mates are consistent and the solver stalled from the
  seed, so reseed the part or check `flip` instead of deleting a mate. Parts
  reachable from a fixed part through fixed, spherical, rotating or
  sliding_rotating mates are seeded in closed form before the solve, so an
  identity seed no longer needs a hand-placed half turn.
- `measure` rehydrates each part's B-rep through OCC (one build per distinct
  part doc), places it, and reports per-body ids `<handle>/<bodyId>`, so
  `compare` works unchanged against a CadQuery assembly reference. `export`
  writes the placed compound as one STEP/STL; `body` is refused for an assembly.
- `run` with `out` ending in `.zip` writes a workspace archive with the
  assembly, every bound part and every `files` entry, ready to import in the
  browser. YAML/JSON `out` writes the assembly document alone.
- `select` stays part-only: it refuses an assembly handle and points at the
  part's docHash.
- Non-goals: sub-assemblies, world-space or cross-instance selection, mate
  expressions, STEP product structure, interference checks and the browser
  drive bridge for the assembly editor. See `feature/backlog.md`.

## What is still open

- Probe phase 2: B-rep face/edge/vertex marks, plane and gizmo pick classes,
  surface holes in probe polygons.
- The browser tier (Playwright): a real pointer smoke scenario asserting
  `inspect()` after each step, plus probe-versus-resolver agreement tests per
  pick class. Deferred pending the owner decision on the browser dependency.
