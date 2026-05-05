import math
import textwrap
import yaml as yaml_module
from pytest import approx
from oversolved.kernel.solver import solve
from solver_helpers import TOL, ATOL, length, is_tangent, to_geom, minimal_sketch_yaml


# ── Step 7: non-front plane sketch solving ──
# These tests ensure constraints solve correctly when the sketch plane is Top or
# Right (non-identity rotation matrix), and that @builtin_origin works across
# all planes.

def test_top_plane_transform_exact_axes():
    """7a: Top plane returns correct row-major rotation [x_axis|y_axis|normal]."""
    result = solve(minimal_sketch_yaml('@builtin_plane_top'))["result"]["sketch_1"]
    t = result["plane_transform"]
    # x_axis=[1,0,0], y_axis=[0,0,-1], normal=[0,1,0]  →  row-major: [1,0,0, 0,0,-1, 0,1,0]
    assert t["rotation"] == approx([1, 0, 0,  0, 0, -1,  0, 1, 0], abs=1e-9)
    assert t["origin"] == approx([0, 0, 0])


def test_right_plane_transform_exact_axes():
    """7b: Right plane returns correct row-major rotation [x_axis|y_axis|normal]."""
    result = solve(minimal_sketch_yaml('@builtin_plane_right'))["result"]["sketch_1"]
    t = result["plane_transform"]
    # x_axis=[0,0,-1], y_axis=[0,1,0], normal=[1,0,0]  →  row-major: [0,0,-1, 0,1,0, 1,0,0]
    assert t["rotation"] == approx([0, 0, -1,  0, 1, 0,  1, 0, 0], abs=1e-9)
    assert t["origin"] == approx([0, 0, 0])


def test_top_plane_horizontal_length_constraint():
    """7c: A horizontal line with a length constraint solves on the Top plane."""
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sk
            kind: sketch
            plane: "@builtin_plane_top"
            entities:
              - {id: ln, kind: line}
            initial:
              ln: [0.1, 0.2, 4.9, 0.8]
            constraints:
              - {id: c_h, kind: horizontal, target: "$ln"}
              - {id: c_l, kind: length, target: "$ln", value: 5.0}
    """)
    result = solve(yaml_str)["result"]["sk"]
    assert result.get("status") != "exception", result.get("exception")
    geom = result["geometry"]["ln"]
    x1, y1, x2, y2 = geom
    assert abs(y2 - y1) < 1e-4, "line must be horizontal (same y)"
    assert abs(math.hypot(x2 - x1, y2 - y1) - 5.0) < 1e-4, "length must be 5.0"


def test_right_plane_vertical_length_constraint():
    """7d: A vertical line with a length constraint solves on the Right plane."""
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sk
            kind: sketch
            plane: "@builtin_plane_right"
            entities:
              - {id: ln, kind: line}
            initial:
              ln: [0.1, 0.1, 0.3, 3.9]
            constraints:
              - {id: c_v, kind: vertical, target: "$ln"}
              - {id: c_l, kind: length, target: "$ln", value: 4.0}
    """)
    result = solve(yaml_str)["result"]["sk"]
    assert result.get("status") != "exception", result.get("exception")
    geom = result["geometry"]["ln"]
    x1, y1, x2, y2 = geom
    assert abs(x2 - x1) < 1e-4, "line must be vertical (same x)"
    assert abs(math.hypot(x2 - x1, y2 - y1) - 4.0) < 1e-4, "length must be 4.0"


def test_top_plane_coincident_with_builtin_origin():
    """7e: A point can be constrained coincident with @builtin_origin on the Top plane."""
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sk
            kind: sketch
            plane: "@builtin_plane_top"
            entities:
              - {id: pt, kind: point}
            initial:
              pt: [3.0, 4.0]
            constraints:
              - {id: c1, kind: coincident, a: "$ptxy", b: "@builtin_origin"}
    """)
    result = solve(yaml_str)["result"]["sk"]
    assert result.get("status") != "exception", result.get("exception")
    geom = result["geometry"]["pt"]
    assert abs(geom[0]) < 1e-4, f"expected x≈0, got {geom[0]}"
    assert abs(geom[1]) < 1e-4, f"expected y≈0, got {geom[1]}"


def test_right_plane_coincident_with_builtin_origin():
    """7f: A point can be constrained coincident with @builtin_origin on the Right plane."""
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sk
            kind: sketch
            plane: "@builtin_plane_right"
            entities:
              - {id: pt, kind: point}
            initial:
              pt: [2.0, -1.5]
            constraints:
              - {id: c1, kind: coincident, a: "$ptxy", b: "@builtin_origin"}
    """)
    result = solve(yaml_str)["result"]["sk"]
    assert result.get("status") != "exception", result.get("exception")
    geom = result["geometry"]["pt"]
    assert abs(geom[0]) < 1e-4, f"expected x≈0, got {geom[0]}"
    assert abs(geom[1]) < 1e-4, f"expected y≈0, got {geom[1]}"


def test_top_plane_circle_radius_constraint():
    """7g: A circle radius constraint solves on the Top plane."""
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sk
            kind: sketch
            plane: "@builtin_plane_top"
            entities:
              - {id: ci, kind: circle}
            initial:
              ci: [1.0, 1.0, 2.5]
            constraints:
              - {id: c_r, kind: radius, target: "$ci", value: 3.0}
    """)
    result = solve(yaml_str)["result"]["sk"]
    assert result.get("status") != "exception", result.get("exception")
    geom = result["geometry"]["ci"]
    assert abs(geom[2] - 3.0) < 1e-4, f"expected radius≈3.0, got {geom[2]}"


def test_gnome_hat_no_tangents(sketch_log):
    """Gnome hat WITHOUT tangent constraints.

    Circle with radius 0.5 at origin, two lines of length 1 meeting at a point.
    One line is vertical. No tangency constraints.
    Expected: Should solve successfully (baseline case).
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Gnome Hat (No Tangents)"
    initial:
      circle:    [0.1, 0.1, 0.45]
      left_line: [-0.4, 0.2, -0.4, 0.9]
      right_line: [0.25, 0.35, -0.6, 1.1]
    entities:
      - id: circle
        kind: circle
      - id: left_line
        kind: line
      - id: right_line
        kind: line
    constraints:
      - id: c_circle_fixed
        kind: fixed
        target: {entity: circle, point: center}
        x: 0.0
        y: 0.0
      - id: c_circle_radius
        kind: radius
        target: {entity: circle}
        value: 0.5
      - id: c_left_len
        kind: length
        target: {entity: left_line}
        value: 1.0
      - id: c_right_len
        kind: length
        target: {entity: right_line}
        value: 1.0
      - id: c_left_vertical
        kind: vertical
        target: {entity: left_line}
      - id: c_left_on_circle
        kind: coincident
        a: {entity: left_line, point: start}
        b: {entity: circle}
      - id: c_right_on_circle
        kind: coincident
        a: {entity: right_line, point: start}
        b: {entity: circle}
      - id: c_apex_coincident
        kind: coincident
        a: {entity: left_line, point: end}
        b: {entity: right_line, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_gnome_hat_no_tangents", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    circle = geom["circle"]
    left_line = geom["left_line"]
    right_line = geom["right_line"]

    # Basic checks
    assert abs(circle["radius"] - 0.5) < TOL
    left_len = length(left_line["start"], left_line["end"])
    right_len = length(right_line["start"], right_line["end"])
    assert abs(left_len - 1.0) < TOL
    assert abs(right_len - 1.0) < TOL
    assert abs(left_line["start"][0] - left_line["end"][0]) < TOL


def test_gnome_hat_one_tangent(sketch_log):
    """Gnome hat WITH ONE tangent constraint.

    Circle with radius 0.5 at origin, two lines of length 1 meeting at a point.
    One line is vertical. LEFT line is tangent to circle.
    RIGHT line has NO tangency constraint.
    Expected: Currently may fail due to solver tangent issues.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Gnome Hat (One Tangent)"
    initial:
      circle:    [0.1, 0.1, 0.45]
      left_line: [-0.4, 0.2, -0.4, 0.9]
      right_line: [0.25, 0.35, -0.6, 1.1]
    entities:
      - id: circle
        kind: circle
      - id: left_line
        kind: line
      - id: right_line
        kind: line
    constraints:
      - id: c_circle_fixed
        kind: fixed
        target: {entity: circle, point: center}
        x: 0.0
        y: 0.0
      - id: c_circle_radius
        kind: radius
        target: {entity: circle}
        value: 0.5
      - id: c_left_len
        kind: length
        target: {entity: left_line}
        value: 1.0
      - id: c_right_len
        kind: length
        target: {entity: right_line}
        value: 1.0
      - id: c_left_vertical
        kind: vertical
        target: {entity: left_line}
      - id: c_left_tangent
        kind: tangent
        a: {entity: left_line}
        b: {entity: circle}
      - id: c_left_on_circle
        kind: coincident
        a: {entity: left_line, point: start}
        b: {entity: circle}
      - id: c_right_on_circle
        kind: coincident
        a: {entity: right_line, point: start}
        b: {entity: circle}
      - id: c_apex_coincident
        kind: coincident
        a: {entity: left_line, point: end}
        b: {entity: right_line, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_gnome_hat_one_tangent", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    circle = geom["circle"]
    left_line = geom["left_line"]
    right_line = geom["right_line"]

    # Basic checks
    assert abs(circle["radius"] - 0.5) < TOL
    left_len = length(left_line["start"], left_line["end"])
    right_len = length(right_line["start"], right_line["end"])
    assert abs(left_len - 1.0) < TOL
    assert abs(right_len - 1.0) < TOL
    assert abs(left_line["start"][0] - left_line["end"][0]) < TOL

    # Verify left line is tangent
    left_tangent_quality = is_tangent(left_line["start"], left_line["end"], circle["center"], left_line["start"])
    assert left_tangent_quality < ATOL, f"left line should be tangent, got quality: {left_tangent_quality}"


def test_gnome_hat_two_tangents(sketch_log):
    """Gnome hat WITH TWO tangent constraints.

    Circle with radius 0.5 at origin, two lines of length 1 meeting at a point.
    One line is vertical. BOTH lines are tangent to circle.
    This is the original gnome hat test.
    Expected: Currently may fail due to solver tangent issues.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Gnome Hat (Two Tangents)"
    initial:
      circle:    [0.1, 0.1, 0.45]
      left_line: [-0.4, 0.2, -0.4, 0.9]
      right_line: [0.25, 0.35, -0.6, 1.1]
    entities:
      - id: circle
        kind: circle
      - id: left_line
        kind: line
      - id: right_line
        kind: line
    constraints:
      - id: c_circle_fixed
        kind: fixed
        target: {entity: circle, point: center}
        x: 0.0
        y: 0.0
      - id: c_circle_radius
        kind: radius
        target: {entity: circle}
        value: 0.5
      - id: c_left_len
        kind: length
        target: {entity: left_line}
        value: 1.0
      - id: c_right_len
        kind: length
        target: {entity: right_line}
        value: 1.0
      - id: c_left_vertical
        kind: vertical
        target: {entity: left_line}
      - id: c_left_tangent
        kind: tangent
        a: {entity: left_line}
        b: {entity: circle}
      - id: c_right_tangent
        kind: tangent
        a: {entity: right_line}
        b: {entity: circle}
      - id: c_left_on_circle
        kind: coincident
        a: {entity: left_line, point: start}
        b: {entity: circle}
      - id: c_right_on_circle
        kind: coincident
        a: {entity: right_line, point: start}
        b: {entity: circle}
      - id: c_apex_coincident
        kind: coincident
        a: {entity: left_line, point: end}
        b: {entity: right_line, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_gnome_hat_two_tangents", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    circle = geom["circle"]
    left_line = geom["left_line"]
    right_line = geom["right_line"]

    # Basic checks
    assert abs(circle["radius"] - 0.5) < TOL
    left_len = length(left_line["start"], left_line["end"])
    right_len = length(right_line["start"], right_line["end"])
    assert abs(left_len - 1.0) < TOL
    assert abs(right_len - 1.0) < TOL
    assert abs(left_line["start"][0] - left_line["end"][0]) < TOL

    # Verify both lines are tangent
    left_tangent_quality = is_tangent(left_line["start"], left_line["end"], circle["center"], left_line["start"])
    right_tangent_quality = is_tangent(right_line["start"], right_line["end"], circle["center"], right_line["start"])
    assert left_tangent_quality < ATOL, f"left line should be tangent, got quality: {left_tangent_quality}"
    assert right_tangent_quality < ATOL, f"right line should be tangent, got quality: {right_tangent_quality}"
