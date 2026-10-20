# The translation corpus

One directory per case: `frontend/translations/<NN-name>/`.

- `recipe.yaml` is a normal Oversolved part document (the same loader a stored
  part goes through), built by the real kernel.
- `source.*` is the model as the other tool authored it, or a written
  derivation when the source is analytic. `reference.json.source.file` names it.
- `reference.json` holds the other tool's report with the oracle's measure
  names: `{ source: { tool, version, file }, tolerance: { rel, abs },
  topology?: "report" | "strict", bodies, volume, area, centroid, bbox,
  faces?, edges? }`. `tolerance` is required so every case states its own
  budget; `topology` defaults to `report`, because another kernel may split
  faces differently while being geometrically equal.

A translation's truth is "another tool says so", a weaker class than the
oracle's closed form, which is why the cases live in their own tier instead of
diluting `frontend/oracle/`. The suite
`frontend/src/translations/__tests__/translationsReal.test.ts` builds every
case through `measureLocally` and compares with `compareMeasures`; the sibling
meta-test `translationsMeta.test.ts` guards the layout and the reference format
without a kernel.

Promotion: a translated case with an analytic answer moves to
`frontend/oracle/` by adding `expected.json` with a `method`.

There is no generated report doc yet: add `docs/translations.md` the way
`docs/oracle.md` is generated once there are enough cases to read.
