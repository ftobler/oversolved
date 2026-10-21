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
| `script(steps)` | step array (below) | `{ ok, steps: [{ index, kind, id, ok, createdIds, error? }] }` |
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
  the seed from crypto once per generation (and per document reset), the CLI
  pins the constant `DRIVE_ID_SEED`, so different sessions differ and a CLI
  script is byte-identical across runs. `randomId` and every mint site that
  routes through it (`uniqueConstraintId`, `freshEntityIds`, `mintEntityId` in
  `frontend/src/utils/yamlMutations/helpers.ts`) mint under that source, so an
  id a handler mints internally (`add_rect`, `add_ngon`, a fresh constraint
  id) is a function of the seed and the source position.
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
npm run drive -- run script.json [--doc doc.yaml] [--out out.yaml] [--repro repro.json] [--file id=path] [--doc-id id]
npm run drive -- commands
npm run drive -- measure doc.yaml [--file id=path]
npm run drive -- compare doc.yaml reference.json [--file id=path] [--doc-id id]
npm run drive -- export doc.yaml --format step|stl [--out out.step] [--body bodyId] [--file id=path]
npm run drive -- replay repro.json
```

- Every command prints one JSON object on stdout; the kernel's own prints
  (OCC's STEP transfer banner) go to stderr, so stdout parses whole.
- `run` builds a document from mutation steps and/or command steps through one
  `DocSession` and the real kernel, optionally writes the final document (`--out`)
  and the journal (`--repro`), and prints steps, document hash and solve state.
  Its journal pins every generation seed to the constant `DRIVE_ID_SEED`, so
  two runs of one script produce byte-identical documents and the recorded
  repro replays exactly (the `cliSmoke` suite runs the box script twice in two
  processes and compares the printed `docHash`).
- `commands` prints the command catalog: every spec id, label, shortcut,
  `undoable` flag, its param fields (`spec.params.fields`, the same schema the
  registry parses a call against) and the live `enabled` verdict from a fresh
  seeded session. Reading the catalog runs no spec body and starts no solve.
  The catalog is the part editor's table (`PART_COMMAND_SPECS`); the assembly
  editor's commands are not on this surface in v1.
- `measure` reports a `MeasureRecord`: `bodies`, `volume`, `area`, `centroid`
  (volume-weighted), `bbox` (an exact six-number AddOptimal box:
  `[xmin, ymin, zmin, xmax, ymax, zmax]`), plus face, edge and vertex counts
  from the final checkpoint's bodies.
- `compare` measures the document and compares it against a `reference.json`
  (the translation format: `source`, a required `tolerance`, an optional
  `topology` mode and the measure fields) with `compareMeasures`. It prints
  `{ ok, pass, rows, measures }`, one row per measure with `ours`, `theirs`,
  `delta`, `within` and `enforced`; exit 0 on pass, 1 on a failing row (or a
  build or kernel error), 2 on a usage error. A failing row is data, not an
  error: `ok` stays true so an agent loop reads which measure diverged.
- `export` writes STEP or STL bytes.
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
solver as unavailable and exits nonzero rather than guessing.

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
| `commands` | none | the command catalog, the same shape as the CLI's `commands` |
| `mutations` | none | the mutation vocabulary grouped by family, plus ready-to-run example scripts |
| `run` | `steps`, optional `doc`, `docId`, `files` | `{ ok, steps, docHash, solve, doc }`; pass `doc` back in to chain edits |
| `measure` | `doc`, optional `docId`, `files` | `{ ok, bodies, volume, area, centroid, bbox, faces, edges, vertices }` |
| `compare` | `doc`, `reference` (inline), optional `docId`, `files` | `{ ok, pass, rows, measures }`; a failing row is data, not an MCP error |
| `export` | `doc`, `format` (step/stl), `out`, optional `body`, `docId`, `files` | writes the file, returns `{ ok, file, format, bytes }` |
| `select` | `doc`, `selector`, optional `docId`, `files` | `{ ok, queries, items }`: the query strings a click would store, plus a geometry summary per item |

- `select` runs a predicate over the solved bodies and returns the exact query
  strings a click would store, so a headless author (an LLM, a translator, the
  fuzzer) can pick a fillet/chamfer/hole target without a pointer. The selector
  is a structured language modeled on CadQuery's string selectors: `kind` is
  `edge` or `face`; `where` combines `and`/`or`/`not` with `parallel`,
  `perpendicular`, `type`, `extreme` (the min/max-projection group, tolerance
  grouped so a box top yields all four edges), `on_face` (edges bounding the
  selected faces), `created_by` (ancestry through the query engine) and
  `radius`. The selector itself is an authoring aid and is never stored: the
  returned queries are what goes into the document, exactly as if each element
  had been clicked. An empty match is a tool error whose message names the
  nearest-miss count per predicate; an unknown predicate key is an invalid
  argument rejected by name. The engine is pure TS in `frontend/src/kernel/select/`.

- `files` is `[{ id, path }]`, the CLI's `--file` flags in JSON form; paths
  resolve against the server's cwd.
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
  budget.
- The server also serves two resources (`resources/list`, `resources/read`):
  `oversolved://schema/part-document`, the JSON Schema for a part document
  (`persistence/partDocSchema.ts`), and `oversolved://catalog/mutations`, the
  same JSON the `mutations` tool returns. Read the schema before authoring a
  document instead of inferring the format from these examples; it pins the
  canonical spellings (feature refs are `@id`, params nest under the kind key).
- `mutations` is the discovery path for the script vocabulary: `commands` act
  on the current selection, while mutation steps author geometry with explicit
  feature and entity ids. Each visible entry carries its fields and a summary,
  and the examples are the box and fillet scripts the catalog tests run against
  the real kernel.
- A payload with `ok: false` comes back with the MCP `isError` flag. The
  JSON-RPC error channel is reserved for malformed requests and invalid
  arguments; unknown fields are rejected by name, so a typo never fails
  silently.
- stdout carries protocol messages only: the entry redirects every other
  stdout write (the OCC STEP writer prints a transfer banner) to stderr.
- The readline loop processes one call at a time, and every `run` is a fresh
  `DocSession` over the real kernel with the CLI journal installed, so the same
  script mints the same ids and hashes the same document on every call. The
  loop's serialization is what keeps the kernel's single-writer cross-solve
  cache honest.

An agent session, entirely over MCP (the `doc` values are the payload of the
previous call):

```jsonc
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run","arguments":{"steps":[
  {"mutation":{"type":"add_sketch","featureId":"sk1","label":"Rectangle","plane":"@builtin_plane_front"}},
  {"mutation":{"type":"add_rect","featureId":"sk1","p0":[0,0],"p1":[10,10]}},
  {"mutation":{"type":"add_extrude","featureId":"ex1","label":"Extrude","sketchQuery":"@sk1","distance":5}}
]}}}
// result.doc is the built document; edit one dimension and rebuild:
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{
  "doc":"<doc from call 1>",
  "steps":[{"mutation":{"type":"set_extrude_field","featureId":"ex1","field":"distance","value":8}}]
}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"measure","arguments":{"doc":"<doc from call 2>"}}}
// {"ok":true,"bodies":1,"volume":800,...}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"compare","arguments":{
  "doc":"<doc from call 2>",
  "reference":{"source":{"tool":"cadquery","version":"2.4.0","file":"source.py"},
    "tolerance":{"rel":1e-5,"abs":1e-6},
    "bodies":1,"volume":800,"area":720,"centroid":[5,5,4],"bbox":[0,0,0,10,10,8]}
}}}
// {"ok":true,"pass":true,"rows":[...],"measures":{...}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"export","arguments":{
  "doc":"<doc from call 2>","format":"step","out":"box.step"
}}}
```

`render_png` is deliberately not offered: the browser's raster path is the
three.js viewport (WebGL, DOM-bound) and the node tier has no offscreen
renderer, so a render tool would mean a new rasterizer rather than a reuse.

## What is still open

- Probe phase 2: B-rep face/edge/vertex marks, plane and gizmo pick classes,
  surface holes in probe polygons.
- The browser tier (Playwright): a real pointer smoke scenario asserting
  `inspect()` after each step, plus probe-versus-resolver agreement tests per
  pick class. Deferred pending the owner decision on the browser dependency.
