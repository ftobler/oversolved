# Untested / Under-tested Areas

## Solver constraints — no test at all

- `vertical` constraint with `a:`/`b:` keys (point-to-point alignment) — only the `target:` (single-entity) form is tested
- `horizontal` constraint with `a:`/`b:` keys (point-to-point alignment) — only the `target:` (single-entity) form is tested
- `angle` constraint between a line and an arc/circle (only line–line is covered)
- `equal_length` with circles or arcs (only line–line is tested)
- `line_distance` with a vertex ref on the `b:` side (e.g. `b: {entity: line1, point: end}`) — the fix to use `get_point` for `b` is untested
- `point_distance` where one or both refs are circle/arc centers rather than line endpoints
- `diameter` constraint render output (`_constraint_render` for diameter) — only the solve side is verified
- `radius` constraint render output — only the solve side is verified
- `midpoint` constraint with `point_a:`/`point_b:`/`point:` three-point form (only the `line:`/`point:` form is tested)
- `midpoint` constraint with `axis: x` or `axis: y` (partial-axis fixing) — all tests use the default `both` axes
- `concentric` between two arcs (only arc–circle and circle–circle are implied; no explicit arc–arc test)
- `fixed` constraint render output structure — no test checks the returned render object fields
- `normal` constraint render for the case where entity `a` is the arc/circle (only `b`-is-arc branch is exercised)

## Solver behaviour — edge cases without tests

- Constraint referencing a **point** entity via `target:`/`a:`/`b:` (e.g. `fixed: target: {entity: pt1}`) — the `get_point` path for `kind == "point"` is untested
- `coincident` between two **point** entities (the point-to-point residual path)
- `coincident` point on an **arc** boundary — `test_coincident_point_on_arc` exists but the arc-angle residual branch inside `coincident` is distinct from the circle branch and worth an explicit check
- `fixed` applied to the **center** of a circle via query string (`target: $circle1center`) — tested only that it doesn't crash after the unresolvable-ref fix, not that it constrains correctly
- `normal` between two **circles** (no test; only line–circle and line–arc are covered)
- `tangent` between a line and an **arc** using `a:`/`b:` keys (the ab-keys test uses a circle; no arc variant)
- Solver result `"constraints"` residual values — no test ever inspects `result["sketch_1"]["constraints"][id]["residual"]`
- Solver result `"features"` per-entity status — no test inspects `result["sketch_1"]["features"][entity_id]`
- `"superfluous"` flag on a constraint — `test_empty_sketch_superfluous_constraint` only checks the sketch-level status, not which constraint is flagged

## Frontend — yamlMutations.ts

- `applyMoveEntity` — no test
- `applyToggleConstruction` — no test
- `applySetConstraintValue` — no test
- `applyAddEntity` — no test
- `applyAddRect` — no test
- `applyAddConstraint` with a `midpoint` (line/point) or `point_distance` kind — the constraint-kind-specific YAML key mapping is untested for these
- `applyDeleteElements` on a **vertex** target (e.g. `vertex:Sketch1:line1:start`) — only entity and constraint deletion are tested

## Frontend — geometryMapping.ts

- `unflattenGeometry` — entirely untested
- `geomPoint` — entirely untested
- `computeConstraintRender` — every constraint branch is untested:
  - `horizontal`, `vertical` (both target and a/b variants)
  - `length`, `radius`, `diameter`
  - `coincident`, `normal`, `parallel`, `angle`
  - `tangent` (both line/arc and a/b variants)
  - `equal_length`, `point_distance`, `line_distance`
  - `midpoint`, `concentric`, `fixed`
  - `coincident` line-to-line (collinear) variant
- `deriveConstraints` — entirely untested
- `fixed` render `point` field (vertex-targeted fixed constraint) — the field was recently added; nothing checks it produces the correct value

## Frontend — stores/sketchEditorStore.ts

- `handleDimClick` — recently added two-click dimension workflow; no test
- `applyConstraint` when selection is empty — no test (should be a no-op)
- `toggleConstruction` — no test
- `deleteSelected` — no test
