"""Drag-stability regularization (drag_anchor hint).

When a sketch feature carries a transient ``drag_anchor`` key (the entity the
user just dragged), the solver adds a linear penalty that biases the constraint
null-space toward the pre-solve state. The dragged entity gets a firmer weight,
so it stays at its dropped position while neighbours absorb the constraint
correction. The penalty also keeps free sized parameters from drifting toward a
singularity. These soft rows must not change the constraint status badges.
"""

import math

from oversolved.kernel.solver import solve


def _result(yaml_str: str) -> dict:
    return solve(yaml_str)["result"]["sketch_1"]


def _dist(a: list, b: list) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ─── Status preservation ───

_UNDERCONSTRAINED = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    {anchor}
    initial:
      line1: [1.0, 2.0, 4.0, 2.0]
    entities:
      - id: line1
        kind: line
"""


def test_drag_anchor_preserves_underconstrained_status():
    """A free line is underconstrained with or without the drag hint: the soft
    penalty rows are excluded from the rank/DOF analysis."""
    plain = _result(_UNDERCONSTRAINED.format(anchor=""))
    dragged = _result(_UNDERCONSTRAINED.format(anchor="drag_anchor: line1"))
    assert plain["status"] == "underconstrained"
    assert dragged["status"] == "underconstrained"
    assert dragged["features"]["line1"]["status"] == plain["features"]["line1"]["status"]


_FULLY = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    {anchor}
    initial:
      line1: [1.0, 2.0, 4.0, 2.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {{entity: line1}}
"""


def test_drag_anchor_preserves_fully_constrained_status():
    """A fully fixed line stays fully constrained with the drag hint, and the
    extra soft loss does not flip it to overconstrained."""
    dragged = _result(_FULLY.format(anchor="drag_anchor: line1"))
    assert dragged["status"] == "fully_constrained"


# ─── Firmness: dragged entity stays at the drop ───

_TWO_POINTS = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    {anchor}
    initial:
      p1: [0.0, 0.0]
      p2: [10.0, 0.0]
    entities:
      - id: p1
        kind: point
      - id: p2
        kind: point
    constraints:
      - id: c_dist
        kind: point_distance
        a: {{entity: p1}}
        b: {{entity: p2}}
        value: 6.0
"""


def test_drag_anchor_holds_dragged_point_and_moves_neighbour():
    """Two free points 10 apart must satisfy a distance of 6. Dragging p2 pins
    it at (10, 0); p1 absorbs almost all of the 4-unit correction."""
    geom = _result(_TWO_POINTS.format(anchor="drag_anchor: p2"))["geometry"]
    p1, p2 = geom["p1"], geom["p2"]
    assert abs(_dist(p1, p2) - 6.0) < 1e-3            # constraint satisfied
    assert _dist(p2, [10.0, 0.0]) < 0.5               # dragged point stays put
    assert _dist(p1, [0.0, 0.0]) > 3.0                # neighbour moves instead
    assert _dist(p2, [10.0, 0.0]) < _dist(p1, [0.0, 0.0])


def test_without_drag_anchor_correction_is_shared():
    """Without the hint there is no penalty, so the minimum-change solution
    splits the 4-unit correction roughly evenly between both points."""
    geom = _result(_TWO_POINTS.format(anchor=""))["geometry"]
    p1, p2 = geom["p1"], geom["p2"]
    assert abs(_dist(p1, p2) - 6.0) < 1e-3
    # p2 is not specially held, so it moves materially (unlike the drag case).
    assert _dist(p2, [10.0, 0.0]) > 1.0


# ─── Anti-collapse: free sized parameter retained ───

_CIRCLE_FOLLOWS = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    {anchor}
    initial:
      p1: [25.0, 0.0]
      c1: [0.0, 0.0, 10.0]
    entities:
      - id: p1
        kind: point
      - id: c1
        kind: circle
    constraints:
      - id: c_center
        kind: concentric
        a: {{entity: c1}}
        b: {{entity: p1}}
"""


def test_drag_anchor_keeps_free_radius_from_collapsing():
    """Dragging p1 drives the concentric circle centre to follow it, while the
    circle radius is unconstrained. The penalty keeps the free radius at its
    initial 10 rather than letting it drift toward a singularity."""
    geom = _result(_CIRCLE_FOLLOWS.format(anchor="drag_anchor: p1"))["geometry"]
    p1, c1 = geom["p1"], geom["c1"]
    assert _dist(p1, [25.0, 0.0]) < 0.05              # dragged point stays at drop
    assert _dist(c1[:2], [25.0, 0.0]) < 0.05          # centre followed via concentric
    assert abs(c1[2] - 10.0) < 1e-3                   # radius did not collapse


# ─── Regression: drag must not fabricate an overconstrained error ───

_TANGENT_LINE = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_top"
    {anchor}
    initial:
      ln: [-4.676, 13.879, -0.2957603546, 4.9862164482]
      circ: [0.0067007292, -0.0026910692, 4.9996135439]
    entities:
      - id: circ
        kind: circle
      - id: ln
        kind: line
    constraints:
      - id: c1
        kind: coincident
        a: {{entity: circ, point: center}}
        b: {{external_xy: [0.0, 0.0]}}
      - id: c2
        kind: tangent
        a: {{entity: ln, point: end}}
        b: {{entity: circ}}
      - id: c3
        kind: coincident
        a: {{entity: ln, point: end}}
        b: {{entity: circ}}
      - id: c4
        kind: diameter
        target: {{entity: circ}}
        value: 10
"""


def test_drag_anchor_does_not_fabricate_overconstrained():
    """A line tangent+coincident to a fixed circle, with a free start vertex,
    is underconstrained. Dragging that vertex must report the same status with
    the anchor as without -- the firmness penalty must never inflate the hard
    loss into a false overconstrained error (bugreports/move_solve_error)."""
    plain = _result(_TANGENT_LINE.format(anchor=""))
    dragged = _result(_TANGENT_LINE.format(anchor="drag_anchor: ln"))
    assert plain["status"] == "underconstrained"
    assert dragged["status"] == plain["status"]
