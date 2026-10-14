# Regression ratchets

Three ratchets catch regressions the unit suites cannot: the action matrix
(every command on every element of a document corpus), the fuzz (seeded random
edit and undo/redo sequences), and the volume oracle (analytic geometry against
the real kernel). Their baselines are committed and reviewed like code. The
nightly Gitea job (`nightly` in `.github/workflows/ci-gitea.yaml`, cron plus
manual dispatch only) provisions the WASM solvers and OCC.js and runs
`just fuzz` then `just ratchet-matrix`.

## Action matrix

`frontend/src/testing/actionMatrix/` replays the corpus documents
(`frontend/src/wasm-kernel/regression-baseline.json` specs plus the doc-shaped
`kernel/features/__fixtures__` files). For each document it enumerates targets
(empty selection, each feature, and each sketch entity, vertex and constraint)
and runs every part command from `PART_COMMAND_SPECS` through
`CommandRegistry.execute` on a fresh headless `DocSession`. The matrix never
calls a mutation handler directly; the context callbacks perform the same
session calls the page handlers do.

Each entry records `ok`, `failed` or `refused` plus its error or refusal text
in `frontend/src/testing/actionMatrix/baseline.json` (72 documents x up to 12
targets x 45 commands, 33,030 rows, one row per line so the diff is readable).

- PR gate: `actionMatrix.test.ts` replays a bounded smoke slice (5 documents,
  6 targets) with the fake scheduler, so it needs no OCC.js, and
  `actionMatrixReal.test.ts` replays three cheap documents on the real kernel
  where installed.
- Nightly: `just ratchet-matrix` (`ACTION_MATRIX_FULL=1`) replays the whole
  corpus exactly against the baseline, with the real kernel when provisioned
  and the fake scheduler otherwise (a command's status cannot depend on the
  scheduler). It takes minutes, not seconds, hence the separate recipe.
- Update: `cd frontend && npm run regen:action-matrix` (vite-node), then review
  the row diff. A new command or corpus document fails the full sweep until the
  baseline is regenerated and reviewed. A row that disappears or changes status
  is a regression.

## Fuzz

`frontend/src/hooks/__tests__/fuzz.test.ts` (harness `fuzzHarness.ts`,
minimiser `fuzzMinimizer.ts`) generates seeded sequences over the 84-type
mutation example registry plus random undo/redo, and drives them through a
fresh `DocSession`. After every step it checks that the document is well formed
and JSON-serializable, the session is idle, no solve crashed and history stays
within its cap; at the end undo-all must return the start document (its undo
stack floor when the cap dropped entries) and redo-all the post-history
document, by deep equality.

- PR gate: bounded defaults (`FUZZ_SEEDS=4`, `FUZZ_STEPS=6` real; 24 x 16
  fake) plus pinned regression seeds and the minimiser tests.
- Long run: `just fuzz <seeds> <steps>` (defaults 200 x 40), widening both the
  fake and real sweeps.
- Failure: a failing seed becomes a pinned regression entry with the seed kept;
  `minimizeSequence` reduces the sequence while a replay still fails.

## Volume oracle

`frontend/src/kernel/occ/__tests__/volumeOracleReal.test.ts` compares
`volumeOf` on the real kernel against closed forms re-derived in the file: box,
cylinder, a Pappus revolve (full and partial turn), and a rounded box by the
Steiner parallel-body formula. The comparator's tolerance is proportional to
the solid's size, unit-tested to reject a shifted value, and the suite skips
cleanly without OCC.js. Extend it case by case, naming the formula in the case.
