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
| `script(steps)` | step array (below) | `{ ok, steps: [{ index, kind, id, ok, createdIds, constraints?, createdCount?, error? }] }` |
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
  back; the sink hashes them there. The entry hash is the authored projection
  (`authoredHashOf`: the document without `part_style` and each feature's
  `initial`), so it is invariant under the solve write-back and a deferred run
  chains the same way a settled one does. That is what makes drawing and
  gestures (which dispatch mutations without a command) journaled, and what
  keeps the solver write-back out (it never goes through the session). A no-op
  apply (whole-document hashes equal) records nothing.
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
  `sha256Hex`. `authoredHashOf` hashes the same way over a shallow projection
  without `part_style` and each feature's `initial`, the two fields the solve
  write-back writes; a repro's baseline and final hash stay the full hash. The
  dirty fingerprint over saved YAML text
  (`frontend/src/session/dirty.ts`) is a different mechanism on the save path.

`repro()` returns the payload `downloadRepro` writes:

```jsonc
{
  "kind": "oversolved-repro",
  "version": 3,
  "docHash": "sha256 of doc",
  "doc": { /* the baseline document */ },
  "seed": 1875250360,
  "warnings": [ "entry 1 (add extrude ex1): applied while a solve was pending; ..." ],
  "journal": [ /* entries */ ]
}
```

`warnings` names every unsettled entry (index plus label or mutation type).
It is empty for a settled recording.

The version names the entry-hash contract. Version 1 (a browser generation)
mints every entry under the top-level seed and hashes the whole document;
version 2 adds a per-step seed on a script entry; version 3, the current shape,
hashes the authored projection. All three replay. The baseline `docHash` is
always the full document hash, so it compares with a `run` reply's `docHash`.

`replayJournal` (`frontend/src/drive/replay.ts`) reproduces a repro on a fresh
session: it checks the baseline hash first, then for every entry checks the
running doc against `docHashBefore`, seeks the id source to `mintIndex`,
applies the mutation (a batch through `executeGroup`), hashes synchronously
right after the apply and compares with `docHashAfter`, and only then settles
the step's solve. Hashing before the settle is what makes record and replay
compare the same authored pre-write-back state; a version-3 entry hashes the
authored projection, so the settle's write-back cannot move the chain either. A
failed apply or a diverged hash stops the replay and reports both hashes; a
`mintIndex` that is not a finite in-range integer is rejected with an
`invalid-mint-index` step failure rather than seeking forever.

Replay is guaranteed when every entry was settled:

- Every CLI and script recording is settled by construction: a run defers its
  solves to a flush, so no apply lands while a solve is in flight, and every
  reply is built after the final flush. Any edit that waited for its solve is
  settled too.
- A repro containing unsettled entries may diverge at the first such boundary:
  a whole-document hash (versions 1 and 2) fails loudly there, and a version-3
  entry still diverges when its handler read the solved state (a mirror or a
  docked dimension). The before-hash check reports the expected and actual
  hashes and stops. That boundary is the documented limit, not silent
  corruption, and the payload's `warnings` names the entries before replay is
  attempted.

The seed travels in the payload (`frontend/src/drive/seededIds.ts`):

- Each generation opens an id source under a recorded seed: the browser draws
  the seed from crypto once per generation (and per document reset), the drive
  CLI and the MCP `run` derive it from the starting document's content hash
  (`driveSeedFor`), so a repeat of the same document and script is
  byte-identical while a call chained onto the previous reply (a different
  starting document) draws a different sequence. A script step's own seed uses
  `authoredHashOf` of the document before it, so a deferred step that never got
  the previous solve's write-back still mints what the same step mid-chunk mints.
  `randomId` and every mint site
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
npm run drive -- run script.json [--doc doc.yaml] [--out tmp/doc.(yaml|json)] [--repro tmp/repro.json] [--file id=path] [--doc-id id] [--frames all]
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
  and the journal (`--repro`), and prints steps, document hash, solve state,
  `solved` (whether a settle was attempted), the
  feature problems (`features`, see the MCP section), the informational
  `notes`, the document's `length_unit` and the sketch and plane `frames` (also
  described there), which by default are only the ones this call touched or
  moved; `--frames all` restores every resolved frame. The same reply carries
  `curves`, the resolved placement of every helix the solve built, and that map
  is never filtered. The `--out` format is
  chosen by the extension: `.json` writes JSON, anything else writes YAML. The
  `--out` path must resolve inside the project's `tmp/` or `bugreports/`
  (relative paths resolve against the repo root, not `frontend/`). `--repro`
  follows the same rule. Both are checked before the script runs, so a refused
  path writes nothing, and both create a missing parent directory at write time.
  An empty script still solves the given document once and prints the same
  fields, so `run` doubles as the "inspect this document" call. A run defers its
  solves: the steps author the document and one solve at the end reports it, so
  `solve.generation` counts solves rather than steps. A step whose mutation names
  a selector and every command step flush the owed solve first (registry code may
  read the solved state), and so does a mutation whose handler reads the sketch's
  current geometry (a mirror, an offset, a relative move, a fit-spline edit or a
  docked dimension); a reply that needs the input document's solve for
  `featureDeltas` or `frames` pays one baseline solve before the steps; both
  opt-ins as `"all"` skip that baseline. Its journal
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
  and vertex counts from the final checkpoint's bodies. The counts are sub-shape
  counts with one exception: `edges` excludes degenerated edges, the same
  population a pick and `select` see, because a pick can only name an edge that
  has geometry; a face and a vertex have no degenerated counterpart and stay
  raw counts. A fillet sphere corner, for example, leaves a degenerate patch
  edge that counts in neither `edges` nor the body's `edge_queries`. `perBody`
  adds one
  entry per live body (`id`, `volume`, `area`, `centroid`, `bbox`), in the
  solve's body order; its volumes and areas sum to the totals and its ids are
  the ids `run` reports. `select` reads the render set instead, so a body whose
  tessellation failed is measured here but is not selectable. An assembly
  measure under `detail: "summary"`
  or `"changed"` keeps the aggregate record and drops this perBody table. The
  same `features`
  problem list `run` returns rides along (measuring builds every feature, so the
  kernel's verdicts are already known), and so do the `notes`, the `frames`
  map, which a measure reply carries in full (every resolved frame), and the
  `curves` map of every resolved helix; a feature
  with no verdict makes `ok` false, exactly as it does for `run`. Every length in
  a measure reply is in the document's `length_unit` (absent means millimetres),
  the same number the document stores; the reply names it as `length_unit`, and
  only the export scales it into millimetres.
- `compare` measures the document and compares it against a `reference.json`
  (the translation format: `source`, a required `tolerance`, an optional
  `topology` mode and the measure fields) with `compareMeasures`. It prints
  `{ ok, pass, rows, measures }`, one row per measure with `ours`, `theirs`,
  `delta`, `within` and `enforced`; exit 0 on pass, 1 on a failing row (or a
  build or kernel error), 2 on a usage error. A failing row is data, not an
  error: `ok` stays true so an agent loop reads which measure diverged. A
  reference is millimetres by construction (no unit field exists), so an inch
  document is measured in its own numbers and the measured copy is scaled into
  millimetres for the comparison; the reply names the document as `length_unit`
  and the rows as `compared_in: "mm"`, while `measures` stays the document's own
  record. An assembly compare keeps its millimetre frame. The translations tier
  calls `measureLocally` and `compareMeasures` directly and every corpus source is
  millimetres, so it is unaffected. A document the settle could not answer for (a
  missing verdict) is `ok: false` instead, because comparing its empty measure to
  a reference would be meaningless.
- `export` writes STEP or STL bytes to `--out` (default `tmp/out.<format>`),
  creating a missing parent directory. The reply carries the same `features`
  problem list and `notes` a run or measure reply does; a failed, partial or
  warned feature
  makes `ok` false and exits 1 while the file is still written, so a file that
  differs from the document is never reported as a clean export. An
  informational note does not enter that verdict: the file is the geometry the
  note describes. The reply names
  `length_unit` (the document) and `file_unit: "mm"` (the bytes). STEP and STL
  are written in millimetres: a part document whose `length_unit` is `inch`
  being exported is scaled by 25.4, so the file's geometry is the physical size
  the authored numbers mean (see `docs/document.md`). An assembly export keeps
  its millimetre frame and does not scale an inch part.
- `replay` applies the recorded mutations to a fresh session under the
  payload's seed, verifies each step's before and after hash (the authored
  projection for a version-3 payload, the whole document for older ones) and
  exits nonzero on divergence.
- `--file <id>=<path>` (repeatable) supplies the bytes for an `import_step`
  feature's `file_id` or for an `import_dxf` step's `file`, the same map the
  browser's file registry hands the worker. The path resolves through the same
  read rule as the MCP `files` map:
  relative paths against the repo root and the file inside `tmp/`,
  `bugreports/` or `scratch/`, so one spelling names one file on both surfaces.
  A STEP file exported by `export` can therefore be re-imported and measured,
  which the `cliSmokeMeasure` suite does end to end. The byte map does not
  travel in the repro payload, so a journal containing an `import_step` replays only with
  `--file` supplied; an `import_dxf` step records the resolved DXF text, so it
  replays without the map.

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
  "args": ["--experimental-strip-types", "--import=./scripts/driveCli.register.mjs", "scripts/mcpServer.ts"],
  "cwd": "frontend"
}
```

`npm run mcp` runs the same entry for manual poking, but npm prints its own
banner on stdout, so a client config must use the direct node invocation.

| Tool | Arguments | Returns |
|---|---|---|
| `commands` | optional `kind` (`part` default, or `assembly`) | the command catalog for that editor |
| `mutations` | optional `kind`, optional `family` (`sketch`, `features`, `picks`, `part style`, `document`, `parts`, `mates`), optional `type` (one name or array), optional `detail` (`full` or `index`) | the mutation vocabularies grouped by family plus ready-to-run example scripts; no argument returns both whole (about 90 kB); `type` fetches one row, `detail: "index"` lists `{type, summary}` only, a filter returns only that slice; an unknown family is refused with the valid list and an unknown type with a did-you-mean when a close name exists |
| `run` | `steps`, optional `doc` or `docHash`, `kind` (fresh only), `parts`, `returnDoc`, `featureDeltas: "all"`, `frames: "all"`, `out`, `detail` (assembly), `docId`, `files` | part: `{ ok, solved, steps, docHash, solve, features, notes, featureDeltas, frames, curves, length_unit, summary, doc?, file?, format? }`; assembly: `{ ok, kind: "assembly", steps, docHash, solve, mates, parts, instances, mateFrames, summary, doc?, file?, format? }` |
| `measure` | `doc` or `docHash`, optional `parts`, `detail` (assembly), `docId`, `files` | part: the `MeasureRecord` plus `features`/`notes`/`frames`/`curves`/`length_unit`; assembly: `{ ok, kind, docHash, ...MeasureRecord, instances, solve, mates, parts }`; under `detail: "summary"` or `"changed"` the aggregate measures, the solve verdict, and the mates and parts problem rows survive, and `perBody` and `instances` are dropped |
| `compare` | `doc` or `docHash`, optional `parts`, `reference` (inline) or `referencePath`, optional `docId`, `files` | `{ ok, docHash, pass, rows, measures, length_unit, compared_in }`; a failing row is data, not an MCP error |
| `export` | `doc` or `docHash`, optional `parts`, `format` (step/stl), `out`, optional `body`, `detail` (assembly), `docId`, `files` | writes the file, returns `{ ok, docHash, features, notes, length_unit, file_unit, file, format, bytes }` for a part or `{ ok, kind: "assembly", docHash, solve, mates, parts, instances, summary, file, format, bytes }`; an assembly `detail: "summary"` (or `"changed"`) keeps the file fields, solve, problem rows and summary and drops `instances` |
| `select` | `doc` or `docHash`, `selector`, optional `detail` (`full` default, or `queries`), `docId`, `files` | `{ ok, docHash, count, queries, items? }`: the query strings a click would store, plus `count` and, in `full` detail, a geometry summary per item (`queries` omits `items`); part documents only |

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
  selected faces), `created_by` (ancestry through the query engine), `radius`,
  `convexity` (edge-only: the analyser's dihedral class, `"convex"`,
  `"concave"`, `"tangent"` or `"other"`) and `seam` (edge-only boolean: the
  face meets itself along the edge). A multi-key example:
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
  `convexity` names the dihedral class the kernel's `BRepOffset_Analyse`
  reports, and it is the analyser's word, not a hand rule: on a slot profile the
  wall-to-wall inside corners are `concave` and the mouth rounds are `convex`
  (the 80-20 rail's two radii are those two groups, 16 edges each), and a mouth
  rim's class is whatever the pinned real test records rather than a guess. A
  seam has the same face on both sides, so the analyse has no dihedral angle and
  reports it as `other`, not `tangent`; `tangent` is a real smooth join and
  `{convexity: "tangent"}` does not include seams. Read `geometry.convexity` on
  an item to learn the class of a body. `seam` is the direct flag: a cylinder,
  cone, sphere or torus closes on itself, and the edge the face meets twice is
  its seam. On a revolved and shelled body `{from: "body_rv1", kind: "edge",
  where: {seam: false}}` is the filletable boundary (the tea_cup recipe), and
  `{not: {seam: true}}` is the same set for an author who prefers negation. A
  face or vertex has no class or seam flag, so both clauses match none of them,
  the `radius`-on-a-vertex rule.
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
  as if each element had been clicked. `count` is the number of matches, the
  same number in both detail modes. `detail` is the reply-size control on this
  tool: `full` (the default) returns `count`, the queries and the per-item
  geometry summary; `queries` returns only `ok`, `docHash`, `count` and the
  queries with no `items` key, so a large match should pass `detail: "queries"`
  rather than spend the caller's token limit on geometry. The values are
  select's own (`full`, `queries`); the assembly tools' `detail` (`summary`,
  `changed`, `full`) is a separate per-tool enum. The engine is pure TS in
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
  for saving or hand-editing. The summary's body ids are the bodies the final
  solve holds, read from its last feature checkpoint's body store, not the
  accumulated `part_style` keys and not the solve response's `bodies` mesh map: a boolean
  or join consumes a body while its colour entry stays behind, and a body whose
  tessellation failed is still solved and measured even though it does not
  render, so the summary includes it. The reply must not name what
  the measure tool no longer counts. A refused script has two states: when no
  settle was attempted (every step refused before a mutation landed), the
  summary says `bodies: not solved (step N refused)` and `solved` is false,
  because the document was never solved and there are no verdicts to list; when
  an accepted prefix settled and the next step was refused, the summary names
  that live set plus `solved through step N-1; step N refused, not applied`, and
  `solved` is true. A step whose solve hit the stall budget says `step N timed
  out` instead of refused. `solved` is the one state flag: it means a settle was
  attempted for the document the reply describes, so a faulted settle still
  lists its missing verdicts. Chaining by hash is the intended flow: a
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
  outcome) and the feature is not listed; the text rides the `notes` channel.
  The
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
  module) is also `ok: false`, with `solve.lastError` naming the fault. A script
  whose steps were all refused before any mutation landed is the one case with
  no verdicts to report: `solved` is false, `features` is empty, and `ok` is
  false because the steps did not apply. The caller's action is to fix the step;
  a `run` with `steps: []` is how to ask that document for its verdicts.
  `export` is the one reply whose `ok` is stricter than a run's: the file is
  the answer, so any feature in `features` (failed, partial or warned) makes it
  `ok: false` even though the bytes are still written; a note does not change
  that verdict. An assembly export
  carries `solve`, `mates`, `parts`, `instances` and `summary` like a measure,
  and is `ok: false` when the solve did not run or a mate or bound part reported
  a problem: the file then holds seed or best-effort poses, and the reply says
  so instead of presenting them as the solved assembly. A `body` that names no
  live body is a tool error naming the live ids (`ExportSelectionError`), not
  an internal error.
  `featureDeltas` answers "what did this step contribute": one row per feature
  this call changed, in log order, with `id`, `kind`, `status`, the cumulative
  `volume` and `bbox` after it (the total over every live body, not one body's),
  and `volumeDelta`/`bboxDelta` from the previous checkpoint. `body` names a
  body the feature changed (the feature's own reported body when that one
  changed, e.g. the merge_target a cut went into), and `bodyVolume` is that
  body's own volume. `changedBodyCount` is set when more than one body changed:
  the row then names the feature's own body only when that body is one of them,
  so a disjoint array reports its copy count instead of its untouched source.
  `body`, `bodyVolume` and the count are absent when no body changed, except
  that a rigid transform or mirror still names its body (a move changes shape or
  placement without necessarily changing volume). `volume` is still the total
  over every live body. A row appears when the feature's checkpoint differs from
  the input document's solve, when the feature is new, or when the steps touched
  a solid-producing feature
  (so an edit that leaves the same volume still shows its zero contribution);
  untouched planes and sketches from an earlier call do not repeat, and neither
  does an existing sketch or plane whose own delta is zero (an upstream edit
  moves its cumulative checkpoint, not its contribution). The first body's deltas start from zero. A failed or
  partial feature
  has no row (its checkpoint may hold half-applied geometry), but that
  checkpoint still sets the baseline for the next built feature, so a later
  delta describes the real part. A feature that built with a warning keeps its
  row and carries the kernel's `warning` text, so a partial tool list's volume
  is visible without a second measure; the row-coverage rule is the same as for
  an unwarned build (changed, new, or touched), so an untouched warned feature
  still appears only under `featureDeltas: "all"`. Pass `featureDeltas: "all"`
  to list every built feature, which is how an empty `steps: []` call inspects
  the whole history.
  The list is null when the final solve exposed
  no measurable checkpoints (the kernel was unavailable or faulted, which is
  also `ok: false` with `solve.lastError`). The checkpoint
  measurement reads each unique OCC shape once, not once per feature.
  Every part reply's measures come from a solve of the stored document. A
  flush whose write-back re-baked sketch geometry (a solve rounded to the
  1e-6 document grid) solves the written document once more, so a reply and a
  later `measure` of its `docHash` agree exactly; a document that never settles
  is solved at most three times and says so in `notes`.
  The `run`, `measure`, `compare` and `export` part replies name the document's
  `length_unit` (`mm` unless the document set `inch`); the numbers themselves are
  never converted. `frames` is filtered the same way as `featureDeltas`: it keeps
  the sketch and `add_plane` frames this call touched or moved, is omitted when
  nothing qualified, and `frames: "all"` restores the whole map. The two opt-ins
  are independent: `featureDeltas: "all"` still reports only the touched or moved
  frames, `frames: "all"` still reports only the changed delta rows, and the
  baseline solve is skipped only when both are `"all"`. `measure` is not
  filtered: it reports every resolved frame.
  `curves` is the other map beside `frames`: the resolved placement of every
  helix, keyed by feature id, as
  `{origin, axis, start, end, radius, pitch, turns, height, hand}`. `axis` is
  the climb direction, so a `direction: reverse` helix reports the negated
  reference axis, and `origin` is the point on the axis the offset already
  moved. It is reported whole and is not filtered by touched or moved: the
  sweep that needs the start is the next call, where the helix itself is not
  touched. The key is omitted when the solve resolved no helix, and a
  suppressed or `exception` helix has no entry because it produced no
  placement. A `--frames all`/`frames: "all"` opt-in does not change it.
- Informational notes ride beside the problem list as `notes`, a list of
  `{ ids, text }` in feature log order. The key is omitted when there is no note
  (unlike `features`, which is always present). A note is not a problem: it adds
  no `features` row, never makes `ok` false and never drops a `featureDeltas`
  row. A feature's own note carries its id once: the tangent chain a fillet or
  chamfer ran along, with the chain and unpicked edge counts, and a warning a
  later feature resolved. A note about a pair of sketches on one stored face
  query carries both ids in log order, so it sorts at the later sketch. That
  check reads every resolved frame before the changed-only filter, so a note can
  name a sketch this call did not touch. A headless flush adds one more note when
  its write-back kept moving sketch geometry through the settle pass cap: it
  names the sketches still moving and says the reply may differ from a re-solve
  of its `docHash` at the 1e-6 level. That note is informational too, so `ok`,
  `features` and the delta rows are unaffected.
- `run` with `steps: []` solves the given `doc` or `docHash` once and returns
  the same reply shape (the frame filter below still applies). It is the
  "inspect this document" call: the solve state has
  a real `generation` and `features` is the document's problem list. A script
  run also solves at the end rather than after each step (a selector, command or
  geometry-reading step flushes first), so `generation` counts solves;
  `featureDeltas` and `frames` each add one baseline solve unless both are
  `"all"`. Its
  `frames` key is absent unless something moved (or `frames: "all"` was
  passed), and null on a stalled call's prefix, which has no settled final
  solve; read an old frame with `measure` or the opt-in. `curves` is still the
  whole map on such a call, because it is never filtered by the changed set.
  A reply's
  `docHash` is stable: `run` with `steps: []` on it, by `docHash` or with its
  exported YAML or JSON as `doc`, returns the same hash. A loaded `doc` is
  stamped with the loader's current version, so a document an older stamp
  migrated on the way in does not migrate again on its next reload.
- `files` is `[{ id, path }]`, the CLI's `--file` flags in JSON form. A path
  resolves through the same project rule as `out`: relative paths against the
  repo root, so `tmp/x.step` names the project's tmp even though the server runs
  with cwd `frontend/`, and the file must stay inside `tmp/`, `bugreports/` or
  `scratch/`. A missing file or a path outside those roots is a tool error
  naming the `files[]` entry, not a JSON-RPC internal error. The map carries
  the bytes an `import_step` feature's `file_id` names and the DXF text an
  `import_dxf` step's `file` field names.
- `run` with `out` writes the final document (the step's own document after a
  refused script, or the checkpoint's document after a stalled one) as JSON for
  a `.json` path and YAML otherwise, and adds
  `file` and `format` to the reply. A stalled call whose first solve never
  settled applied no step, so its input document is also its final document; it
  is written with `solved: false`. `compare` with `referencePath` reads the
  reference from a file instead of inline. `run`'s `out`, `export`'s `out` and
  `compare`'s `referencePath` all resolve relative paths against the repo root,
  so `tmp/x.json` names the project's tmp even though the server runs with cwd
  `frontend/`. A written document or export must stay inside `tmp/` or
  `bugreports/`; a reference may also come from `scratch/`. Anything else is
  refused with the allowed directories named. A missing parent directory is
  created at write time, so a fresh run directory needs no pre-making. The file
  reference goes through the same corpus validator as the inline object.
- A `run` whose solve stops announcing features for the stall budget is
  answered with the state it holds, not a bare timeout: when the worker posted a
  checkpoint for an accepted step, the reply carries `ok: false`, that
  document's `docHash`, the settled `steps` plus the step that timed out
  (`error.code: "solve-timeout"`), `solved: true`, `features: []`, null
  `featureDeltas` and `frames`, a summary naming the accepted prefix, and the
  `out` file. A run defers its solves, so the stall usually lands in the final
  flush after every step applied; the reply then names the timeout as a
  synthetic `id: "final solve"` step after the applied ones, and the saved
  document includes those steps' mutations. A stall before the first settle has
  no checkpoint and keeps the tool-error shape; with an empty script and `out`
  the input document is written as above. The 30 s budget, the single worker and
  stop-on-first-error are unchanged, and the killed worker is replaced for the
  next call.
- `compare` takes its `reference` inline (the agent has just produced it) and
  validates it through the corpus parser, so a reference missing `tolerance`
  or carrying a malformed bbox is JSON-RPC invalid-params, not a tool error.
  A reference is millimetres by construction, so an inch document is measured
  then scaled into millimetres for the comparison; the reply names
  `length_unit` (the document) and `compared_in: "mm"` (the rows), and
  `measures` stays the document's own record. The reference shape is the
  translation file format:

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
  budget. A strict `edges` reference states the pickable population above, so
  record the kernel version that produced it: a different OCCT build can report
  a different sub-shape population even when the geometry matches. The five
  measures `bodies`, `volume`, `area`, `centroid` and `bbox`
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
  degrees and arcs sweeping counter-clockwise). An `add_entity` end that meets a
  neighbour does so only by coordinate, so it is not constrained to it; a line
  that closes a profile onto an existing end should pin it instead, with
  `add_entity_with_constraint` or an explicit `coincident`. `import_dxf` takes the
  ASCII DXF text inline (`content`) or the id of a DXF entry in the run's `files` map
  (`file`; give exactly one of the two), parses it with the same module the sketch
  toolbar's file picker uses, and appends the supported entities to one sketch
  as one undo entry; its row note lists the supported entity kinds, the
  annotation entities that are skipped, and the `$INSUNITS` rule. Its step reply
  is compact: `createdIds: []` and `createdCount`, because one import can add
  hundreds of entities and the document resource has their ids. The
  `set_*_field` value note emits the enum members of every enum field in that
  kind's schema
  (`operation: add|cut|new`, `direction: normal|reverse|symmetric`,
  `termination: blind|up_to|through_all`, `operation: new|replace`), and an
  extrude's `through_all` termination is a cut sized from the bodies it can
  reach, so `distance` is ignored and `merge_target` narrows the reach to one
  body. `direction: symmetric` cuts through all material on both sides of the
  profile plane; `normal` and `reverse` cut one side, ahead of the plane along
  the sweep direction. An extrude `taper` is the draft angle in degrees:
  positive narrows, negative widens, every lateral wall drafts (holes included),
  and it needs `termination: blind` with `direction: normal` or `reverse`;
  symmetric, up_to and through_all are refused, as is a taper that collapses the
  profile before `distance`. `add_plane`'s `definition` carries the same shape the part-document
  schema serves (its `mode` enum includes `offset`, and the common offset plane is
  `{mode:"offset", plane:"@builtin_plane_top", offset:43}`). A multisection
  sweep is one `add_sweep_profile` per section and `multisection: true` in the
  add call (or a later `set_sweep_field {field:"multisection", value:true}`);
  every section must be pierced by the path. Each section is one outer loop, so
  a section with a hole is refused, and loops that cross each other are NOT
  unioned in a section: draw one closed outer loop per section. A single-profile
  sweep carries the profile from the path start as drawn, so a profile beside
  the path, or off its plane, keeps its offset in the moving frame; it must lie
  within its own size of a path crossing, or of the path start when the path
  never crosses its plane, and the path start must leave the plane at 5 degrees
  or more. A profile lying along the path is refused, not built. A profile or
  path ref is a whole sketch
  (`$<sketchId>` or `@<sketchId>`), one curve (`entity:<sketchId>:<entityId>`),
  or a `?` area query from `select`; a sweep takes one `entity:` ref per curve
  (a slotted loop needs its two lines and two arcs as four refs, one
  `add_sweep_profile` per curve) and one path ref per curve, while extrude and
  revolve take one closed curve per ref. `vertex:` refs name the same entity as
  `entity:`, and a `@<sketchId>/<entityId>` or `@<bodyId>/face/<n>` pick is a
  face profile, which a sweep refuses. A bare `$<helixId>` (or `@<helixId>`)
  names a helix as the path, the way to sweep a thread; it must stand alone as
  the only path ref and is refused with `multisection`. See `docs/document.md`,
  helix. To sweep a shape that has a hole, sweep the outer loops in one `add`
  feature and the inner loops in a second `cut` feature of the same path, with
  the cut naming its `merge_target` so it cannot reach an unrelated body. The
  blend between sections is not a loft:
  `sweep.multisection` is the feature for it. `add_sweep` takes `transition`,
  `multisection`, `operation` and `merge_target` inline, the same keys
  `set_sweep_field` sets.
  A `fit_spline`'s `params` are its flat fit points (`x0, y0, ..., xN-1, yN-1`,
  2..64 points). The optional `tangents` pair (`[start, end]`, each `[tx, ty]`
  or null) is converted to the stored absolute end handles (the first piece's
  second control point and the last piece's third); `tangentScale` defaults to
  true, CadQuery's `scale=True`, and applies OCCT's `ScaleTangents` once at
  authoring. With no tangents the ends take the Lagrange derivative, exactly
  like CadQuery. Mapping: CadQuery `spline(points, tangents, scale)` is
  `params: points`, `tangents`, `tangentScale: scale`.
  Each tangent is an end derivative vector, so its length is that end's
  magnitude: `tangentScale: false` keeps the authored length, while the default
  `true` replaces it with OCCT's `ScaleTangents` value and keeps only the
  direction. A per-end tangent scalar is the unit direction times that scalar,
  with `tangentScale: false`. The stored start handle is
  `P0 + h0 * t0 / 3` and the end handle `P_last - h_last * t1 / 3`, with `t0`
  and `t1` the end tangents after any `ScaleTangents` scaling, and `h0` and
  `h_last` the first and last chord lengths (the end handle is the last
  piece's third control point, hence the minus). `set_fit_spline_handle` writes
  that stored absolute form directly on a later edit; it is not the authoring
  recipe, and its end point differs in sign from the tangent.
  Guidance that a field list cannot carry lives in the row note: `hole` lists
  its required fields (`sketch`, `diameter`, `depth_mode`) and its optional ones
  (`depth`, `direction`, `target`, `thread`, `style`, `cb_diameter`, `cb_depth`,
  `cs_angle`, `tip`, `tip_angle`, `thread_depth`), with `depth` required only for a blind hole because a
  `through_all` hole is sized by the target body and stores no depth; all are
  optional in an `add_hole` payload. The widened mouth is one field,
  `cb_diameter`, under both the `counterbore` and the `countersink` style, so
  `cs_angle` is the only `cs_` field and there is no `cs_diameter`. An empty
  value clears the `target` pick, on the inline add and on `set_hole_field`
  alike (the hole then drills the body its drill sites sit on); every other
  field refuses an empty value rather than silently reverting to its default,
  and `null` clears an optional field, while null on a required field is
  refused by name (deleting the key would let the loader quietly fall back to
  a default). With no `target`
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
  ids in bottom, right, top, left order, and all three of `add_rect`,
  `add_center_rect` and `add_ngon` take optional `entityIds` (the whole block:
  4 lines; 4 lines in that same order then the centre point; n lines in chain
  order then the circumcircle) so a script can name a side in its own step;
  `add_three_point_arc` takes `start`, a point `through` the arc, and `end`
  (CadQuery's `threePointArc` order), stores the arc CCW, and pins an end to
  `startRef` / `endRef` (a vertex ref or a point-on-curve entity ref); without
  refs the ends land within about 1e-6 of the given points, so a profile closes
  but is not constrained to a neighbour; its step reply carries `vertexKeys`
  (`{ start, end }`), naming the stored vertex key that holds each given point;
  `add_revolve` takes the required
  `axis` inline (`@<sketchId>/<entityId>` or an edge query from `select`) plus
  `direction`, `operation` and `merge_target`, the same keys
  `set_revolve_field` sets, and an axis that crosses a profile's interior is
  refused by name. A revolve angle is a positive magnitude: a negative angle is
  refused and the message names `direction: "reverse"` for the other way round.
  `add_transform` takes `bodies` and every `set_transform_field` field inline,
  so one call replaces the add plus one setter per field; the transform itself
  applies scale first, then rotation, then translation. The rotation is either
  about exactly one axis given as `rotation_axis` (a ref) or as
  `rotation_axis_origin` plus `rotation_axis_direction`, or about one
  `rotation_euler` triple of extrinsic XYZ degrees (world X first, then world Y,
  then world Z; numbers only, pivoting about `rotation_axis_origin` or the world
  origin). `rotation_euler` cannot be combined with `rotation_axis`,
  `rotation_angle` or `rotation_axis_direction`; clear the other spelling with a
  null value before setting the triple; `add_boolean` takes `operation`,
  `target`,
  `tools`, `keep_tools` and `clearance` inline, with `clearance` a signed
  offset on a subtract tool; `add_fillet` takes all of `edges` and
  `radius` in the same call and continues along the pick's whole tangent chain
  (one edge of a rounded loop rounds the loop), so the reply carries a `notes`
  entry with the chain and unpicked edge counts; it is informational and does
  not change an export's `ok`, because the geometry is what the pick produces;
  `add_shell` takes `faces`, `thickness`, `direction` and `join` in the same
  call, `thickness` is a positive magnitude with `direction` carrying the side,
  and `join` is `sharp` (the default) or `arc`. Sharp keeps the part's authored
  corners; arc rounds the offset gap and matches CadQuery's default
  `kind="arc"`: on a 2 mm cube shelled 0.05 outward `Ex017` measures 1.0405
  with the default against CadQuery's 1.031678, and 1.031678 with
  `join: "arc"`. A default sharp build still falls back to arc when the sharp
  offset refuses, and reports that in the reply's `notes`;
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
  the mirrored copies are plain authored geometry, not a live mirror relation
  (a source whose mirror is itself, such as a seam on the axis, gets no copy
  and serves both halves);
  `fillet_corners` takes `radius` and a non-empty `corners` list of
  `{a, aVertex, b, bVertex, side?}` naming two line entities of one sketch and
  the endpoints that meet, trims each endpoint to its tangent point and adds one
  tangent arc per corner; each joint it leaves is a coincident on the trimmed
  endpoint and the arc end, plus a tangent between each side and the arc; an arc
  or projected side, a mixed construction corner,
  a `fixed`/dimension on a trimmed endpoint, or a radius that would consume a
  side is refused by name, and one step is one undo entry;
  `apply_offset` takes `sourceIds` and a signed `distance` and clones each
  source; a connected chain (coincident or coordinate-joined) is refitted corner
  to corner, every rebuilt joint carrying a coincident on the two copy vertices,
  a sharp joint mitred on the offset curves, and a tangent joint keeping the
  coincident plus a `tangent` between the two curves; a sharp joint whose offset
  curves do not meet stays open;
  `pattern_entities` takes `sourceIds` and a `mode`: `linear` (`count`,
  `pitch`, `direction`), `grid` (`count`, `count2`, `pitch`, `pitch2`,
  `direction`, `direction2`), `rotate` (`count`, `angle_deg`, `center`) or
  `copy` (`angle_deg`, `center`, `translate`, `targetFeatureId` for a sketch on
  the same plane); `count` includes the source, a field from another mode, a
  stacked copy, more than 200 instances or more than 4096 sketch entities is
  refused by name, the copies are plain authored rows whose ids the reply
  reports instance by instance in `sourceIds` order, and one step is one undo
  entry;
  `add_text` takes `text` and optional `origin`, `size`, `angle` and `align`
  (`left | center | right`) and writes the string's glyph outlines as plain
  line and spline rows; a character outside printable ASCII is refused by code
  point, a run over 2000 entities is refused, a missing sketch is an
  `unknown-target`, and the reply carries `createdCount` with `createdIds: []`,
  like `import_dxf`;
  `add_variable` must sit
  before every feature that names it, and `reorder_features` takes exactly one
  of `toIndex` (which counts the seeded plane rows), `before: <featureId>` or
  `after: <featureId>`, while `add_plane` takes `before` to insert in place;
  `delete_feature` removes only the named row, so a
  dependent stays in the log and reports its missing input; and a body-subject
  pattern's `operation: add` only fuses copies that touch, so disjoint copies
  split into bodies named with `_1`, `_2`... suffixes. `add_pattern` and
  `add_mirror` take their whole payload inline: `add_pattern` takes every
  pattern field (`subject`, `source_body`, `source_feature`, `mode`,
  `operation`, `include_source`, the one-axis `count`/`pitch`/`direction`
  family, the rectangular `count_x`/`count_y`/`pitch_x`/`pitch_y`/`direction_x_query`/`direction_y_query`
  family, `step_angle`, `axis`/`axis_origin`/`axis_direction` and the invert
  flags), and `add_mirror` takes `body`, `plane`, `keep_original` and `merge`,
  so one call replaces the add plus one setter per field.
- `add_pattern` with `subject: body` (the default) copies `source_body` through
  a linear, rectangular or circular grid. `operation: add` unions each copy
  into the source body when they touch; a copy that does not touch is a new
  part, so a disjoint copy takes a `_1`, `_2`... sibling id. `operation: new`
  keeps the source as instance 0 and mints one body per copy.
- `add_pattern` with `subject: feature` repeats one earlier FEATURE's own add
  or cut inside the body it already shaped, so a repeated slot or boss needs no
  separate body and boolean. `source_feature` names an earlier `extrude`,
  `revolve` or `sweep` whose operation is `add` or `cut`. `count` is the TOTAL
  instance count, including the source's own application (count 2 adds one
  copy, count 1 is a no-op). Linear mode reads `pitch` plus `direction` or
  `direction_query`; rectangular mode reads the two `count_x`/`count_y` axes;
  circular mode reads `step_angle` (absent means `360/count`) plus `axis` or
  `axis_origin` + `axis_direction`. `target_body` names the body when the
  source feature touched more than one; otherwise the one body the source
  created or modified is used, and zero or several candidates are refused with
  the list. A copy that cannot apply is named: some applied is a `partial`
  feature listing how many copies landed and which copy failed, none applied is
  an error. An add copy that does not touch the target becomes its own body; a
  cut copy that misses is still named. A source with `operation: new` or an
  `up_to` extrude is refused by name, because a new body is not "inside the
  existing body" and an up_to trim would travel with every rigid copy. A
  through_all cut is a legal source: its tool is measured from the body the
  copies will cut, so every copy clears the same thickness.
- A sketch is one profile, and a profile fills even/odd: a loop nested inside
  another is a hole (a disc plus a circle becomes a washer), while loops that
  CROSS each other are filled as their union. A circle meant as a hole that
  pokes past the rim of another loop therefore adds a bump where it crosses
  instead of cutting a notch, with no warning: `Ex007` measures 1.5036 against
  the 1.4726 of the same sketch with that hole inside the rim. Keep a cut loop
  inside its boundary, or cut with a separate sketch.
- A sketch line split by a construction line, and collinear lines that meet end
  to end, extrude, revolve and sweep as one lateral face: the profile fuses
  collinear and co-circular neighbours before the wire is built. The sketch
  itself keeps its pickable pieces and its area division.
- Plane refs are exact. `add_sketch.plane`, `set_feature_plane.plane`,
  `add_split.plane`, `set_split_field` with `field: "plane"`,
  `add_plane.definition.plane` and `set_plane_definition_field` with
  `field: "plane"` accept `@builtin_plane_front`, `@builtin_plane_top`,
  `@builtin_plane_right`, the bare names `Front`/`Top`/`Right` (case-sensitive),
  `@<planeId>` for a plane feature, or a `?` face query from `select` (the
  stored `?...:flatface` string), so a face pick can place the sketch in one
  step (`add_split` and `set_split_field` take the flat-face form only; a curved
  face is refused). In an `add_plane` definition the ref is the parent plane,
  and only the modes that consume a parent (`offset`, `plane_point`,
  `origin_rotation`) read it; a `?` flat-face query parent supplies that face's
  axes and normal. An unmatched NAME is refused with the valid list; a name never
  falls back to the XY plane. A face query is resolved after the solve, and a
  plane or face query that does not resolve fails the sketch or `add_plane`
  feature with the cause named: a plane feature defined later in the log (a
  sketch's message names the one-step fix,
  `reorder_features {featureId: <planeId>, before: <sketchId>}`) or a face
  query nothing registers any more. Only an absent or empty query keeps Front.
  `add_sketch.plane` and `set_feature_plane.plane` also take the selector
  itself, `{selector: <a select selector naming exactly one face>}`: the
  headless drive resolves it against the settled solve and stores the query
  string it matched, so no `select` round trip or paste is needed. The same
  form is accepted per `add_shell.faces` entry, where a selector may expand to
  several faces, and per `add_fillet.edges` / `add_chamfer.edges` entry, where
  it expands to every edge it matches; a selector is never stored. `edges` is a
  list field, so spell a lone selector `edges: [{selector: ...}]`; the object
  form is refused as a non-array.
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
  `rotation` turns x and y about the normal by that many degrees. The parent
  `plane` is `@builtin_plane_front`, `@builtin_plane_top`,
  `@builtin_plane_right`, a bare builtin name (`Front`, `Top`, `Right`;
  case-sensitive), `@<planeId>`, or a `?` flat-face query from `select`; only
  the modes that consume a parent (`offset`, `plane_point`, `origin_rotation`)
  read it, and the other modes ignore it.
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
    `rotation_axis` is a WORLD axis in both spellings, not the parent frame's
    own x/y/z, so a 60 degree turn about `x` over a non-XY parent keeps the
    world +X direction fixed rather than the parent's own x.
    `rotation_axis` and `rotation_angle` are required together; the common
    in-plane `rotation` still applies last.
- Read the frame from the reply. A `run` reply carries `frames`, an object keyed
  by feature id whose entries are `{origin, x_axis, y_axis, normal}` for each
  sketch and `add_plane` feature this call touched (the ids its steps created or
  named) or whose frame differs from the input document's solve; a frame that
  did not move and that the call did not touch is left out, and the key is
  absent when nothing qualified, which is why a fillet-only or `steps: []` call
  on an unchanged document reports none. Pass `frames: "all"` for every resolved
  frame, or use `measure`, which is the measurement call and always reports every
  resolved frame (it has no steps and therefore no changed set). Frames are
  rounded to the document's 6 decimals. A suppressed feature or one whose solve
  threw (status `exception`) has no entry because it produced no frame-bearing
  result; an overconstrained sketch still reports the plane it solved on.
  `{origin, x_axis, y_axis, normal}` is world space, Y-up, in the same frame the
  document and `compare` use. Two sketches drawn on one stored face query resolve
  that query at their own position in the log, so a feature between them that
  changed the face moves the later sketch's frame; when their frames differ, the
  reply's `notes` names both sketches and the origin distance (or the axes, when
  only those moved). That check reads every resolved sketch before the
  changed-only filter, so it also fires on a call that touched neither sketch.
- Read a helix's placement from the reply too. `curves.<id>` carries
  `{origin, axis, start, end, radius, pitch, turns, height, hand}` for every
  helix the solve resolved, so a sweep profile can sit on `start` without a
  throwaway probe plane. `axis` is the climb direction, not the reference axis:
  `direction: reverse` negates it. `@<id>/start` and `@<id>/end` remain valid
  point refs (for example a plane's `origin`), and the two agree with the
  reported points. The display polyline is not part of the reply.
- A payload with `ok: false` comes back with the MCP `isError` flag. The
  JSON-RPC error channel is reserved for malformed requests and invalid
  arguments; a user error a valid request reaches (an unknown export `body`, a
  `files` path outside the read roots or one that cannot be read) is the same
  `ok: false` payload, never a -32603 internal error. Unknown fields are
  rejected by name, so a typo never fails silently. A step's mutation goes
  through the catalog validator, and there the
  refusal also names the nearest field the row declares (`cs_diameter` -> did
  you mean `cb_diameter`?), so one call fixes the guess. No field alias is
  accepted: one meaning keeps one spelling, the same rule the `select`
  vocabulary follows. That includes an inline `doc` (or a `parts` `{doc}`):
  after the load it is checked against the served part or assembly schema, so a
  misspelled key refuses with its path. The browser loader is deliberately
  tolerant of unknown keys, so a newer file still opens in an older build.
- `initialize` instructions and the `select` description carry one generated
  world-frame sentence (from `BUILTIN_PLANES`): Y is up, each builtin plane's
  normal and sketch axes, and that an extrude goes along the normal. It is
  generated rather than hand-typed so a plane change cannot leave it stale.
  `initialize` also carries the generated face-frame sentence (from
  `normalToFrame`), the +Z/-Z/+Y/-Y/+X/-X table above and the advice to read a
  feature's frame from the `frames` map. A hand-typed sentence beside them names
  the document's `length_unit`, the `set_length_unit` mutation and the fact that
  reply numbers follow the document's unit while STEP and STL leave in
  millimetres; it excepts the compare reply, whose rows are millimetres and are
  labelled `compared_in`.
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
  {"mutation":{"type":"add_extrude","featureId":"ex1","label":"Extrude","sketchQuery":"$sk1","distance":10,"operation":"new"}}
]}}}
// {"ok":true,"docHash":"<hash1>","summary":"features: sk1 (sketch), ex1 (extrude); bodies: ...",...}
// 2. Pick the four Y-parallel edges (Y is up, so these are the 10 mm verticals).
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"select","arguments":{
  "docHash":"<hash1>","selector":{"kind":"edge","where":{"parallel":[0,1,0]}}
}}}
// {"ok":true,"docHash":"<hash1>","count":4,"queries":["?..."],"items":[...]}
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
// {"ok":true,"docHash":"<hash2>","features":[],"file":".../tmp/box.step","format":"step","bytes":...}
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

- `add_step_part` imports a STEP file straight into the assembly, without a
  hand-made part document: `{ "handle": "housing", "file": "f1", "name":
  "Housing" }` with the bytes supplied as `files: [{ "id": "f1", "path": ... }]`.
  The session synthesizes the part document that owns the imported body (the
  built-in references plus one `import_step` feature), binds it under the
  derived id `step_<file id>` and places the instance, all as one undo step.
  The step result's `part` names `{ docId, name, fileId }`, and the composite
  handle carries the binding, so a chained `measure` or `export` needs only the
  same `files` map. Importing the same file id again under another handle reuses
  that one part document (and its first name, and one bundle); a derived binding
  that already names a part which does not import the file is refused rather
  than replaced. The undo entry covers the instance, not the binding: `undo`
  removes the instance and leaves the part available.
- `detail` trims an assembly `run`, `measure` or `export` reply (default
  `full`, today's reply). Each tool keeps its own key set:
  - `run`, `summary` keeps `ok`, `docHash`, the solve verdict, dof and
    iterations, the mate and part problem rows and the one-line `summary`.
    `changed` adds the instances whose solved pose moved against the starting
    document's solve (a throwaway extra solve, paid only for this level), the
    mate frames of mates the call added or edited or that have a problem,
    `solve.mates` for problem mates only, and the refused steps whole (accepted
    ones collapse to `stepsAccepted`, except a step carrying a `captured`
    report, which stays whole).
  - `measure`, `summary` keeps `ok`, `docHash`, the aggregate `MeasureRecord`
    (`bodies`, `volume`, `area`, `centroid`, `bbox` and the topology counts),
    the solve verdict and the mate and part problem rows, and drops `perBody`.
    A measure does not return the one-line summary. `changed` keeps the same
    fields with the solve trimmed to the mate and part rows that reported a
    problem; a measure has no starting document, so it lists no instances.
  - `export`, `summary` keeps `ok`, `docHash`, the solve verdict, the mate and
    part problem rows, the one-line `summary` and the file fields (`file`,
    `format`, `bytes`), and drops `instances`. An export has no starting
    document, so `changed` is treated as `summary`. `full` keeps today's reply.
    `ok` is still the export's own verdict, computed before the trim, so a
    failed mate or a bound-part problem is `ok: false` with the file written.
  On a part document `run`, `measure` and `export` refuse `detail` (a part
  reply has no detail levels); `select` has its own `detail` enum (`full` or
  `queries`). Under a `run`'s `summary` and `changed` the
  reply's `steps` key becomes `stepsAccepted` (a count) plus `steps` holding
  only the refused ones.
- A sketch step's `createdIds` is how a later step in the same `run` names
  what it made: one `add_rect` with `entityIds` (the rect family authors its
  whole id block) can be revolved about `@sk1/<id>` without a read-back.
  `add_rect`, `add_center_rect` and `add_ngon` steps report `createdIds` as
  the entity ids in minting order (rect: bottom, right, top, left lines) plus
  `constraints: <count>`; the constraint ids stay readable from the document
  resource. `mirror_entities` reports its copy ids in source order,
  `pattern_entities` instance by instance in `sourceIds` order and
  `fillet_corners` one arc id per corner, each with `constraints: <count>`.
  An `import_dxf` or `add_text` step reports `createdIds: []` and
  `createdCount: <entities>` instead, because one step can add hundreds of
  entities; a sketch copy step that creates more than 200 ids reports them the
  same way. The ids of such a step stay readable from the document resource,
  and the run's `docHash` names the document that holds them. Other mutations
  list every id
  they create. In an assembly, an
  ordinary mutation step's `createdIds` names the assembly features it added,
  in document order: `inst_<handle>` for an `add_part`, the mate's `featureId`
  for an `add_mate`, or `inst_<newHandle>` for a `duplicate_part`.
  `add_part_pattern` instead keeps its documented per-copy order, each copy's
  instance id then its mate id. A mutation step that creates nothing (a ref or
  parameter edit, a delete, a reorder, a visibility or fixed toggle) reports
  `[]`. The ids ride on a step row, so a `summary` or `changed` reply drops them
  with the accepted rows it collapses; only a `full` reply names them.
- The reply's `docHash` is the assembly handle. It folds the assembly document
  and every bound part's content hash, so a chained `measure { "docHash": A1 }`
  needs no second argument, and a part edit yields a new handle. `parts` on a
  chained call overrides one binding and mints a new handle.
- A mate ref is a part-local pick: `{ part: <handle>, query: <a select query> }`,
  `{ part: <handle>, selector: <exactly one entity> }`, `{ part: <handle>,
  anchor: <anchor id> }`, the part's own frame `{ part: <handle>, anchor:
  "Origin" }` (`Origin`, `Top`, `Front` and `Right` are always available;
  `Origin` and `Front` face +Z, `Top` +Y, `Right` +X), or the assembly frame
  `{ part: "__assembly", anchor: "AssemblyTop" }`. Run `select` on the part's
  own docHash to get queries; the selector is an authoring aid and is never
  stored. A mate selector is validated exactly like the `select` tool's
  argument, so the `"x" | "y" | "z"` extreme-axis sugar works and a typo is
  refused with the same wording. An unknown name is refused with the part frame
  names, the `select` route and the bundle's anchor-id route all listed. Only
  `{ part, anchor, anchor_descriptor }` reaches the document.
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
  poses the solve starts from, and freezes them into the mate. For a `fixed`
  mate it also stores the seed translation as the mate's `offset`, carried into
  A's part frame (`R_a^T (p_b - p_a)`), so "place them, then capture" holds the
  whole relative pose. The solve then
  holds the pose you seeded instead of one you found by trial solving, without
  having to learn each circle edge's axis direction from a failed solve first.
  An explicit `flip`/`angle`/`offset` in the same step wins over the captured
  value, and the step result carries `captured: { flip, angle, roll, offset }`
  (angle only for `fixed` and `sliding`, roll only for `rotating`, offset only
  for a `fixed` mate whose seed translation is non-zero and in A's local frame;
  plus `overridden: [...]` when an explicit value beat a captured one) so the
  reply says what was frozen into the document. A `rotating` mate never
  captures an angle, because that would lock the hinge; its `roll` is the
  measured seed roll, reported and never written, in the `limit_min`/`limit_max`
  coordinate (signed degrees in (-180, 180]). Opening the hinge N degrees from
  the seed is `angle = roll + N`, and a bound around the seed is the roll plus
  or minus the tolerance; with no `angle` the hinge's zero is the canonical
  frames' dihedral, not the seed. Under `detail: "changed"` a step carrying
  `captured` stays whole in `steps`. The
  default is `capture: false`, so a document authored before this existed
  keeps its meaning, and a kind with no authored orientation (spherical,
  tangential, copy_rotation) captures nothing.
  Read the reply's `mateFrames` (each mate's posed anchors, with the stored
  `anchor` id and the solved pose in the assembly frame) to see which way an
  axis points at the solved pose. A frame anchor's `point` is local to its part
  (the part origin is `[0, 0, 0]` in that frame), the same point a `fixed`
  offset is measured from.
- A mate `offset` is a number along A's anchor axis or a partial `{x, y, z}`
  in body A's part frame (it rotates with A). The sign reads "B's anchor
  sits at A's anchor PLUS the offset": the `add_mate` above with
  `"offset": 5` rests the pin's anchor 5 above the plate's top face (its
  outward normal), while a negative value sinks it into the plate.
  `parallel_plane_distance` reads the same value as the plane separation along
  A's normal, `tangential` as a surface clearance, and `sliding` refuses an
  offset (it would pin the joint's only translational DOF).
- `limit_min`/`limit_max` bound a single-DOF joint one-sidedly. On `sliding`
  they are millimetres of axial separation of B's anchor from A's, along A's
  world axis; on `rotating` they are degrees about the same canonical roll zero
  as `angle`, signed and inside (-180, 180]. Both bounds are inclusive and add no
  constraint while the joint is inside the range, so a bounded joint is still
  free between its stops; a missing key is an open end, and an inverted pair is
  refused with the reason (a rotating range crossing the +/-180 cut folds to an
  inverted pair and has no single signed spelling). A lone out-of-range rotating
  endpoint is refused rather than folded: a max above 180 allows every reachable
  roll, while the folded value would name a real one-degree stop. The v5
  migration only folds a complete pair whose folded form stays ordered. A solve
  reports a reached bound as
  `solve.mates.<id>.limit: "min" | "max" | "both"`, `mateFrames.<id>.limit`,
  and a `limits:` segment in the summary; reaching a stop is not a problem, so
  `ok` stays true and the mate does not join the `mates` problem list.
  `overconstrained` is reserved for a mate set with no pose that satisfies every
  mate and limit (for example a slide bounded at 20 next to a plane separation
  of 30).
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
