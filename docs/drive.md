# Drive Surface, Journal and Headless CLI

Three surfaces make the running app driveable from outside, all built on the
same command set:

- the dev bridge, `window.__oversolved`, installed by the part editor in
  development and test builds;
- the command journal, a ring of doc-changing commands that a repro downloads
  and a replay reproduces;
- the headless CLI, which runs the same scripts and journals through the real
  kernel in node, with no browser at all.

The source lives in `frontend/src/drive/` (bridge, script runner, journal,
replay, headless session) and `frontend/scripts/driveCli.ts` (CLI).

## Gating and installation

`Part.tsx` installs the bridge only when `DRIVE_ENABLED` is true
(`frontend/src/drive/gate.ts`):

```ts
export const DRIVE_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test'
```

Vite folds the constant at build time, so the production bundle drops the
installer call and the whole bridge module with it, and contains no
`__oversolved` string. The install returns an uninstall that clears the global
only while it still holds that same surface, so a remount cannot delete a
newer bridge.

The bridge is installed by the part editor (the assembly editor has none in
v1). The registry itself is wrapped in a journaling subclass in dev/test builds
(`useDriveCommandRegistry.ts`), so the journal records every doc-changing
command the editor executes whether it came from the toolbar, a key binding,
the bridge or a script.

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

The journal is a ring (capacity 500) of entries recorded at the registry
execution seam:

```ts
{ commandId: string, params: unknown, docHashBefore: string, docHashAfter: string, at: number }
```

- Only a command that changed the document hash records an entry. Selection
  changes, tool switches and other UI-only commands leave nothing, and the
  solver write-back is not a command at all, so it is never journaled.
- When the ring fills, it restarts as a new generation with the incoming
  command as its first entry: what remains is always a contiguous, replayable
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
  "journal": [ /* entries */ ]
}
```

`replayJournal` (`frontend/src/drive/replay.ts`) reproduces a repro: it checks
the baseline hash first, executes each command, and after every step compares
the live document hash with the recorded `docHashAfter`. A failed command or a
diverged hash stops the replay and reports both hashes.

### Journal versus crash recovery

The journal is deliberately kept beside the workspace recovery mechanic, not
inside it:

- `frontend/src/stores/recoveryStore.ts` owns crash-at-restart: the U7 prompt
  over the `workingRev`/`savedRev` pair in `workspace/store.ts`. It asks
  whether to keep (adopt) or discard the working copy and writes nothing until
  the user answers. It answers "adopt or discard the working copy".
- The journal owns command-level reproduction. It answers "here is the exact
  command sequence that produced this document".

The two share no state and never feed each other.

## Headless CLI

The CLI runs beside `frontend/scripts/regenCorpus.ts` with the same
`--experimental-strip-types` recipe, plus a loader shim for `import.meta.env`:

```bash
cd frontend
npm run drive -- run script.json [--doc doc.yaml] [--out out.yaml] [--repro repro.json] [--doc-id id]
npm run drive -- measure doc.yaml
npm run drive -- export doc.yaml --format step|stl [--out out.step] [--body bodyId]
npm run drive -- replay repro.json
```

- `run` builds a document from mutation steps and/or command steps through one
  `DocSession` and the real kernel, optionally writes the final document (`--out`)
  and the journal (`--repro`), and prints steps, document hash and solve state.
- `measure` reports `bodyCount`, `volume` (`volumeOf` from
  `frontend/src/kernel/occ/volume.ts`) and face/edge/vertex counts from the
  final checkpoint's bodies.
- `export` writes STEP or STL bytes.
- `replay` verifies a repro hash by hash and exits nonzero on divergence.

One session per process is the v1 contract: `solveLocally` keeps its
cross-solve checkpoint cache as single-writer module state, so two sessions in
one process would interleave their caches. Run two processes instead of
isolating the kernel globals. Command-driven adds mint deterministic
`<kind>_<n>` ids from a per-session counter, and mutation steps pass explicit
entity/feature ids where the handler accepts one, so a script replays to the
same document hash.

When OCC.js or the nodejs Rust solver build is absent, the CLI reports the
solver as unavailable and exits nonzero rather than guessing.

## What is still open

- Probe phase 2: B-rep face/edge/vertex marks, plane and gizmo pick classes,
  surface holes in probe polygons.
- The browser tier (Playwright): a real pointer smoke scenario asserting
  `inspect()` after each step, plus probe-versus-resolver agreement tests per
  pick class. Deferred pending the owner decision on the browser dependency.
