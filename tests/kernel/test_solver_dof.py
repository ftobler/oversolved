"""Tests for rigid-body DOF counting with full-entity fixed constraints.

A full-entity fixed constraint (no "point" key, no "x"/"y" keys) pins all
parameters of the entity (line=4, circle=3, arc=5, point=2), not just 2.
This matches the branch logic in solver_residuals._build_residuals_fn and
the ENTITY_SIZES constant from solver_constants.
"""

from oversolved.kernel.solver import solve


def _status(yaml_str: str) -> str:
    return solve(yaml_str)["result"]["sketch_1"]["status"]


# ─── Line + full-entity fixed ───


def test_line_full_entity_fixed_is_fully_constrained():
    """A line with a full-entity fixed constraint (no point/x/y keys) pins
    all 4 params, so the sketch is fully constrained with no other constraints."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [1.0, 2.0, 4.0, 2.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: line1}
"""
    assert _status(yaml_str) == "fully_constrained"


def test_line_point_fixed_only_is_underconstrained():
    """A line with only a start-point fixed constraint (2 DOF) still has
    free direction and length, so the sketch is underconstrained."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
"""
    assert _status(yaml_str) == "underconstrained"


def test_line_xy_fixed_without_point_is_underconstrained():
    """A fixed constraint with x/y keys but no point key uses the 2-DOF path
    (matches residual logic), so a line with only this is still underconstrained."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: line1}
        x: 0.0
        y: 0.0
"""
    assert _status(yaml_str) == "underconstrained"


# ─── Circle + full-entity fixed ───


def test_circle_full_entity_fixed_is_fully_constrained():
    """A circle has 3 parameters (cx, cy, r). A full-entity fixed constraint
    (no point/x/y keys) pins all 3, so the sketch is fully constrained."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      circ1: [2.0, 3.0, 1.5]
    entities:
      - id: circ1
        kind: circle
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: circ1}
"""
    assert _status(yaml_str) == "fully_constrained"


# ─── Mixed point-fixed and full-entity fixed ───


def test_mixed_full_entity_fixed_two_lines():
    """Two lines, each with a full-entity fixed constraint, are both fully
    constrained (4+4 = 8 DOF pinned for 8 parameters total)."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 3.0, 0.0]
      line2: [3.0, 0.0, 6.0, 0.0]
    entities:
      - id: line1
        kind: line
      - id: line2
        kind: line
    constraints:
      - id: c_fix1
        kind: fixed
        target: {entity: line1}
      - id: c_fix2
        kind: fixed
        target: {entity: line2}
"""
    assert _status(yaml_str) == "fully_constrained"


# ─── Regression: original point-fixed path still works ───


def test_point_fixed_plus_other_constraints_fully_constrained():
    """The original path (point-fixed = 2 DOF) still works: fixing start +
    horizontal + length fully constrains a line."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.2, 0.2, 4.8, 0.3]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 5.0
"""
    assert _status(yaml_str) == "fully_constrained"
