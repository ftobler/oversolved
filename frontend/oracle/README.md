# The reference oracle corpus

One directory per case: `frontend/oracle/<NN-name>/`.

- `recipe.yaml` is a normal Oversolved part document (the same loader a stored
  part goes through), built by the real kernel.
- `expected.json` holds `{ method, bodies, volume, area, centroid, bbox,
  faces?, edges?, edit? }`, where `method` states the closed-form formula and
  `edit` optionally edits an upstream dimension and states the edited state's
  expectation (persistent-naming assertion).

The suite `frontend/src/oracle/__tests__/oracleReal.test.ts` builds every case,
measures volume/area/centroid/bbox with the real kernel, round-trips the part
through STEP, compares against the formulas with a 1e-6 relative tolerance, and
regenerates the report `docs/oracle.md` (`npm run docs:oracle`). The sibling
meta-test `corpusMeta.test.ts` and the report's own "Layout" section document
the contract; minimised fuzz recipes can be dropped in here following the same
two-file layout.

## Corpus notes

- There is no all-edges chamfer case. Where three chamfers meet at a box
  vertex, OCC builds a corner patch rather than the ideal half-space
  intersection, so no closed form describes the built shape. The all-edges
  case is covered instead by `08-fillet-all-edges` (the Steiner parallel-body
  formula is exact), with `10-chamfer-one-edge`, `11-chamfer-vertical` and
  `33-chamfer-vertical-naming` covering chamfers.
- The spheres in cases 22 to 24 are modelled as a semicircular arc plus its
  diameter line, revolved 360 degrees. There is no sphere primitive feature;
  that revolve is the product's own construction path.
