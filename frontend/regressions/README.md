# The regression corpus

One directory per case: `frontend/regressions/<kebab-name>/`, no `NN-` prefix
(a bug report has no natural order).

- `recipe.yaml` is the document exactly as it was exported, random ids and all.
  It loads through `partSpecFromText`, the same loader a stored part uses.
- `checks.json` is the readable contract: where the case came from, its licence,
  whether it fails the gate, and what must hold.
- `snapshot.json` is optional and generated. It freezes the sorted per-body
  face/edge fingerprints, which catches a face split or a lost body that
  measures alone miss.

A regression's truth is the kernel's own earlier output for a real document,
which is why the folder lives beside the oracle (`frontend/oracle/`, closed-form
truth) and translations (`frontend/translations/`, another tool's report) rather
than inside either. The suite `src/regressions/__tests__/regressionsReal.test.ts`
builds every case once and prints a failure as
`<case>/<check>: ours=... expected=...`; the no-kernel sibling
`regressionsMeta.test.ts` guards the layout, licence allow list and loader. The
runner is `src/regressions/run.ts`; the loader/validator is
`src/regressions/corpus.ts`.

## checks.json

```json
{
  "origin": { "kind": "bug_report", "ref": "feature/<topic>.md or commit", "date": "2026-10-22" },
  "license": "own",
  "severity": "hard",
  "what": "two rings on the front plane, up_to extrude onto a body 3 face",
  "features": { "default": "ok", "except": { "<featureId>": "exception" } },
  "tolerance": { "rel": 1e-6, "abs": 1e-6 },
  "topology": "strict",
  "measures": { "bodies": 2, "volume": 30512.09, "faces": 20, "edges": 48 },
  "snapshot": true
}
```

- `origin.kind`: `bug_report`, `real_doc`, `exploration`, `fuzz` or `curated`.
  `ref` names the report, plan or commit; `date` is when it was admitted.
- `license`: `own`, or `{ "spdx": "...", "source": "...", "commit": "..." }`
  for a promoted third-party model. The allow list is MIT, Apache-2.0,
  BSD-2-Clause, BSD-3-Clause and CC0-1.0; anything else fails the meta-test.
  This is the clean-room gate for exploration-sourced cases.
- `severity`: `hard` fails `just frontend`; `soft` warns (the old `REAL-SOFT`).
  `REGRESSION_SOFT=1` downgrades every case for an inventory run.
- `features`: the solve status every recipe feature must report. A sketch's
  status is its constraint verdict, so `fully_constrained` and
  `underconstrained` are pinned like `exception` is. A pinned `exception` is a
  known bug: if the kernel starts solving it, the case fails and forces a regen
  and review.
- `measures`: the oracle's measure names. `bodies` is required; the rest are
  checked only when present. `centroid` and `bbox` may be `null` for a document
  with no body.
- `topology`: `strict` enforces `faces`/`edges`; `report` compares them and
  warns without failing the case.
- `snapshot`: `true` requires `snapshot.json`; the file is refused without it.

## How to direct this

Ask an agent, for example:

- "add this bug report as a regression case"
- "re-check the regression corpus"
- "why does `real-star` fail, and is the case or the kernel wrong?"
- "this case fails after my change, is that intended?"

To add a bug case manually:

```bash
cd frontend
npm run regressions:add -- path/to/exported-doc.yaml my-bug-name --snapshot
npm run regressions:regen -- my-bug-name
```

`regressions:add` copies the document, solves it once through the real kernel
and writes a `checks.json` that already passes. Then edit the defaults: set
`origin.ref` to the bug report or commit, a one-line `what`, and decide whether
the case is `hard` or `soft`. It refuses to overwrite an existing case; a bug
case is evidence, so update it deliberately rather than replacing it.

When a change to the kernel is intended, regenerate the affected cases with
`npm run regressions:regen -- <name...>` (all cases when none are named). The
reviewable output is the small per-case `checks.json` / `snapshot.json` diff;
`origin`, `license`, `severity`, `what` and `tolerance` are never rewritten,
and a measure the case omits stays omitted (only `bodies` is always kept).
Do not regen to make a red case green before deciding the change is correct.

These decisions stay with you:

- `hard` versus `soft`, and admitting a case whose geometry is still wrong;
- loosening a tolerance or switching `topology` to `report`;
- checking in a third-party source at all, and under which licence;
- keeping a case whose bug is fixed (turn the pinned `exception` into `ok` and
  regen) versus deleting it;
- whether a divergence is the kernel regressing or the case needing a new
  expected result.

`just frontend` builds every committed case through the real kernel, so a new
case is checked automatically once committed. Provision locally with
`just install-occ` and `just wasm`; without the kernel the suite skips like every
other `*Real` suite.
