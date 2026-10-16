# Sketch repros

Recorded browser sessions for the sketch area builder, replayed headless by
`src/kernel/__tests__/sketchRepros.test.ts`.

## Building the oracle

The replay test calls the fuzz-gated `check_topology_violations` export, so the
sketch-solver node package must be built with the cargo feature:

```sh
just wasm   # builds sketch-solver pkg-node with `-- --features fuzz`
```

or by hand from `sketch-solver/`:

```sh
wasm-pack build --target nodejs --out-dir pkg-node --release -- --features fuzz
```

The production web build (`--target web`, `pkg/`, what `just wasm` copies into
`frontend/public/wasm`) stays feature-free on purpose: the oracle is a test
judge and must not ship. A `pkg-node` that exists without the export makes the
test fail with this rebuild instruction instead of skipping, because a silent
skip here would hide the whole suite from CI.

## Recording

1. Run a dev build (`just dev`) and click until the sketch looks wrong.
2. In the console: `window.__oversolved.downloadRepro()`, then drop the file
   here.
3. Optional: write a sidecar `<name>.expect.json` stating what you saw and what
   you expected, for example

   ```json
   { "sketch": "sk1", "status": "underconstrained", "areas": 3 }
   ```

   `sketch` is the feature id, `status` the solve verdict the UI showed
   (`fully_constrained`, `underconstrained`, `overconstrained`; underscores are
   ignored), `areas` the number of selectable areas the sketch should have.
   Without a sidecar the test only checks the oracle invariants.

A repro whose payload carries `warnings` was recorded while a solve was still
pending and fails the replay at the first divergence: record more slowly (wait
for the solve to settle) or record again.

## What the test checks

The test replays each file through `replayJournal` and the headless part
session (the same path `npm run drive -- replay` uses), then runs the area
builder's invariant oracle over every sketch's final geometry and any sidecar
expectation. A finding here is a real area-builder bug on a real document; the
repro is the fixture, so keep it until the fix lands.
