# Regression ratchets

Four ratchets catch regressions the unit suites cannot: the action matrix
(every command on every element of a document corpus), the fuzz (seeded random
edit and undo/redo sequences), the geometry robustness fuzz (seeded feature
chains against the real kernel) and the volume oracle (analytic geometry
against the real kernel). Their baselines are committed and reviewed like code.
The Gitea `ratchets` job in `.github/workflows/ci-gitea.yaml` runs on main only
(a push or a manual dispatch there): it provisions the WASM solvers and OCC.js
and runs `just fuzz`, `just ratchet-matrix` then `just robustness-fuzz 1500`,
teeing every recipe to tmp/ and uploading the logs as its report artifact.

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
in `frontend/src/testing/actionMatrix/baseline.json` (74 documents x up to 12
targets x 48 commands, 36,048 rows, one row per line so the diff is readable).

- PR gate: `actionMatrix.test.ts` replays a bounded smoke slice (5 documents,
  6 targets) with the fake scheduler, so it needs no OCC.js, and
  `actionMatrixReal.test.ts` replays three cheap documents on the real kernel
  where installed.
- Main gate: `just ratchet-matrix` (`ACTION_MATRIX_FULL=1`) replays the whole
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

## Geometry robustness fuzz

`frontend/src/testing/robustnessFuzz/` is the geometry side of the fuzz, built
on the same seeded PRNG (`makePrng` from `hooks/__tests__/fuzzHarness.ts`) and
the same minimiser (`fuzzMinimizer.ts`). `recipe.ts` draws a recipe per seed: a
start body (box, rounded-arc extrusion or revolve) plus up to eight edits (fuse
and cut of boxes, cylinders and spheres, fillet, chamfer, hole, linear and
circular array, mirror), all on a 2.5 mm grid and anchored to the running
body's bounding box, so flush faces and tangencies are drawn often. `chain.ts`
replays a recipe through the leaf feature solvers and after every step asserts
the feature contract: the step built or refused with a message (a throw is
classified, never aborts the run), the handle table and disposal counters match
the store, every body is one valid solid with a positive finite volume, and a
cut never adds volume while a join never removes it. `booleanIdentityReal`
checks V(A u B) + V(A n B) = V(A) + V(B) within 0.2% on primitive pairs, and
the persistence half of `chain.ts` rebuilds every chain under a one-grid-step
upstream dimension change and reports every recorded pick that no longer
resolves; a chain that already refused only reports picks the rebuilt range
reached again, a completed one also reports references it never reached.

- Every replay runs in a forked child under a SIGKILL watchdog
  (`chainTimeout.ts`, mirroring `kernel/solveTimeout.ts`): an OCC clean can
  spin forever in synchronous WASM, and the killed seed is reported with the
  step that hung. `ROBUSTNESS_FUZZ_WORKERS` (default 2) recipes replay
  concurrently, each in a child that replays exactly one recipe and is then
  retired: a reused child carried OCC state into the next seed and flipped
  borderline fuses and picks between runs. A kill drops only its own child,
  and the seed range is slotted by seed and aggregated in seed order, so the
  findings depend on neither the pool width nor the schedule. Each child
  holds its own ~0.75 GB OCC kernel, which is why the recipe pins the pool
  and `VITEST_MAX_FORKS=1` together; raise
  workers only on a wide, memory-rich box. `KNOWN_HANGS` and `KNOWN_STALE_PICKS`
  in `chainReal.test.ts` pin the triaged findings; anything else fails the
  sweep. The pins key on the recipe a seed draws, so a change to the recipe
  generator (a new step kind, a moved roll threshold) redraws most seeds and
  needs a fresh 1500-seed triage in the same batch.
- PR gate: bounded 24 chain seeds and 32 identity seeds. On a Node older than
  22.6 the watchdog child cannot start (--experimental-strip-types), so the
  chain sweep skips there rather than fail; the CI matrix runs one such leg.
- Long run: `just robustness-fuzz <seeds> <workers>` (chain default 200, the
  plan's acceptance range; identity a quarter of it, floored at 32), 1500 in
  the main gate and 5000 for a dedicated full-scale run; the tee'd log is the
  report.
- Failure: the violations are minimised by dropping steps and the minimal
  recipe is written under `src/testing/robustnessFuzz/regressions/` as a triage
  artifact for a human (nothing replays the directory yet); the oracle corpus
  takes part documents with closed-form expectations, a different shape, so
  fuzz recipes do not go there.

## Volume oracle

The ratchet is a corpus: `frontend/oracle/<NN-name>/` holds one directory per
case with a `recipe.yaml` (a normal Oversolved part document, built through
the real loader and kernel) and an `expected.json` whose `method` states the
closed-form formula for the measures it lists (volume, area, centroid, bbox,
and optional face/edge counts). A case may carry an `edit` block: an upstream
dimension is changed, the document is rebuilt, and the downstream
fillet/chamfer must still resolve its stored picks (counts and measures).

`frontend/src/oracle/__tests__/oracleReal.test.ts` (node, real OCC) measures
every case with GProp and Bnd_Box, round-trips the part through STEP and
re-measures, and compares against `expected.json` with the tolerance
comparator in `frontend/src/kernel/occ/measureTolerance.ts` (also used by the
original seed, `volumeOracleReal.test.ts`, which keeps its own unit tests).
`docs/oracle.md` is generated from the run and drift-checked; regenerate with
`cd frontend && npm run docs:oracle`.

- Provisioning: the suites self-skip without OCC.js, but both CI workflows set
  `KERNEL_PROVISIONED` on their provisioned vitest jobs, arming a guard that
  fails rather than skips there when OCC.js or the solver WASM is missing.
- Meta test: `corpusMeta.test.ts` enforces the corpus contract (both files, a
  non-empty `method`, every case in the report) with no kernel, so a stale
  report fails even on the unprovisioned legs.
- Add cases one at a time, naming the formula in the case's `method`.
