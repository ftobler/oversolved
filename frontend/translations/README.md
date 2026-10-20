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

## How to direct this

Ask an agent, for example:

- "translate <source> into a translations case"
- "re-check the translations corpus"
- "this case fails, find out whether we or the reference are wrong"

A case is accepted only with all three files: the source as the other tool
wrote it, the Oversolved `recipe.yaml`, and a `reference.json` produced by
running that source, with a stated tolerance. The agent proposes the tolerance
from the source tool's own precision; you decide whether it is acceptable.

When you read a `compare` result, the rows that always matter are `bodies`,
`volume`, `area`, `centroid` and `bbox`. A `faces` or `edges` mismatch is
usually fine: another kernel may split the same shape into a different number
of faces or edges. It only matters when the case sets `topology: strict`. A
volume or bbox miss usually means the recipe is not the same solid as the
source, so look for a missing hole, a different fillet or a wrong dimension.
Fix the recipe rather than widening the tolerance to hide it.

These decisions stay with you:

- accepting a looser tolerance than the agent proposed,
- making a case `topology: strict`,
- promoting a translated case to the oracle (it needs a written `method`),
- dropping a case whose source tool is wrong or whose model cannot be expressed,
- checking in a third-party source at all, and under which licence.

`just frontend` builds every committed case through the real kernel against its
frozen reference and compares it, so a new case is checked automatically once
committed. That gate does not need CadQuery. Producing or regenerating a
reference does: `just install` puts CadQuery in `.venv`, and the reference
runner is the only part that uses it.

There is no generated report doc yet: add `docs/translations.md` the way
`docs/oracle.md` is generated once there are enough cases to read.
