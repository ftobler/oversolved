# Sketch repros

Recorded browser sessions for the sketch area builder, replayed headless by
`src/kernel/__tests__/sketchRepros.test.ts`.

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
