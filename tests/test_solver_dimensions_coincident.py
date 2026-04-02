import math
import yaml as yaml_module
from oversolved.solver import solve
from solver_helpers import TOL, ATOL, length, is_tangent, to_geom


# ---------------------------------------------------------------------------
# Dimension constraint tests
# ---------------------------------------------------------------------------


def test_dimension_circle_diameter(sketch_log):
    """Circle constrained by diameter (not radius)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Circle diameter"
    initial:
      circ: [3.0, 2.0, 1.5]
    entities:
      - id: circ
        kind: circle
    constraints:
      - id: c_diam
        kind: diameter
        target: {entity: circ}
        value: 6.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_dimension_circle_diameter", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    assert abs(geom["circ"]["radius"] * 2 - 6.0) < TOL


def test_dimension_line_to_line_distance(sketch_log):
    """Two horizontal parallel lines constrained to a fixed perpendicular distance."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Line to line distance"
    initial:
      line_a: [0.0, 0.0, 4.0, 0.0]
      line_b: [0.0, 0.8, 4.0, 0.8]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_horiz_a
        kind: horizontal
        target: {entity: line_a}
      - id: c_horiz_b
        kind: horizontal
        target: {entity: line_b}
      - id: c_fix_a
        kind: fixed
        target: {entity: line_a, point: start}
        x: 0.0
        y: 0.0
      - id: c_dist
        kind: line_distance
        a: {entity: line_a}
        b: {entity: line_b}
        value: 3.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_dimension_line_to_line_distance", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    a_start = geom["line_a"]["start"]
    b_start = geom["line_b"]["start"]
    dist = abs(b_start[1] - a_start[1])  # both horizontal, so y-diff is distance
    assert abs(dist - 3.0) < TOL


def test_line_distance_self_reference_rejected(sketch_log):
    """line_distance with a == b (same entity) must be rejected immediately.

    The point on a line always has zero distance to that line, so any non-zero
    value target is unsatisfiable and the solver would silently waste its full
    evaluation budget. A self-referencing distance is a user error and should
    return status: exception with a descriptive message.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Self-distance"
    initial:
      line3: [0.0, 0.0, 4.0, 0.0]
    entities:
      - id: line3
        kind: line
    constraints:
      - id: c_line_distance_8
        kind: line_distance
        a: $line3
        b: $line3
        value: 2
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_line_distance_self_reference_rejected", yaml_str, result)
    assert result["status"] == "exception"
    assert "same entity" in result["exception"]


def test_dimension_circle_center_to_point(sketch_log):
    """Distance from circle center to an external point."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Circle center to point"
    initial:
      circ: [0.0, 0.0, 1.0]
      pt:   [5.0, 0.2]
    entities:
      - id: circ
        kind: circle
      - id: pt
        kind: point
    constraints:
      - id: c_fix_circ
        kind: fixed
        target: {entity: circ}
        x: 0.0
        y: 0.0
      - id: c_dist
        kind: point_distance
        a: {entity: circ}
        b: {entity: pt}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_dimension_circle_center_to_point", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    cx, cy = geom["circ"]["center"]
    px, py = geom["pt"]["x"], geom["pt"]["y"]
    dist = math.hypot(px - cx, py - cy)
    assert abs(dist - 5.0) < TOL


# ---------------------------------------------------------------------------
# Coincident constraint tests
# ---------------------------------------------------------------------------


def test_coincident_point_to_point(sketch_log):
    """Two free point entities pulled to the same location."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident point-point"
    initial:
      pt_a: [1.0, 2.0]
      pt_b: [4.0, 5.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 1.0
        y: 2.0
      - id: c_coin
        kind: coincident
        a: {entity: pt_b}
        b: {entity: pt_a}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_point_to_point", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    ax, ay = geom["pt_a"]["x"], geom["pt_a"]["y"]
    bx, by = geom["pt_b"]["x"], geom["pt_b"]["y"]
    assert abs(bx - ax) < TOL
    assert abs(by - ay) < TOL


def test_coincident_point_on_line(sketch_log):
    """A free point constrained to lie on a fixed horizontal line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident point-on-line"
    initial:
      line1: [0.0, 2.0, 8.0, 2.0]
      pt:    [3.0, 5.5]
    entities:
      - id: line1
        kind: line
      - id: pt
        kind: point
    constraints:
      - id: c_fix_line
        kind: fixed
        target: {entity: line1}
      - id: c_coin
        kind: coincident
        a: {entity: pt}
        b: {entity: line1}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_point_on_line", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    line = geom["line1"]
    px, py = geom["pt"]["x"], geom["pt"]["y"]
    # Line is horizontal at y=2; point must be at y=2
    dx = line["end"][0] - line["start"][0]
    dy = line["end"][1] - line["start"][1]
    n = math.hypot(dx, dy)
    nx, ny = -dy / n, dx / n
    vx = px - line["start"][0]
    vy = py - line["start"][1]
    perp_dist = abs(vx * nx + vy * ny)
    assert perp_dist < TOL


def test_coincident_point_on_circle(sketch_log):
    """A free point constrained to lie on the circumference of a fixed circle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident point-on-circle"
    initial:
      circ: [0.0, 0.0, 3.0]
      pt:   [1.0, 1.0]
    entities:
      - id: circ
        kind: circle
      - id: pt
        kind: point
    constraints:
      - id: c_fix_circ
        kind: fixed
        target: {entity: circ}
        x: 0.0
        y: 0.0
      - id: c_radius
        kind: radius
        target: {entity: circ}
        value: 3.0
      - id: c_coin
        kind: coincident
        a: {entity: pt}
        b: {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_point_on_circle", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    cx, cy = geom["circ"]["center"]
    r = geom["circ"]["radius"]
    px, py = geom["pt"]["x"], geom["pt"]["y"]
    dist = math.hypot(px - cx, py - cy)
    assert abs(dist - r) < TOL


def test_coincident_point_on_arc(sketch_log):
    """A free point constrained to lie on the arc (circle of the arc)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident point-on-arc"
    initial:
      arc1: [0.0, 0.0, 4.0, 0.0, 90.0]
      pt:   [1.0, 1.0]
    entities:
      - id: arc1
        kind: arc
      - id: pt
        kind: point
    constraints:
      - id: c_fix_arc
        kind: fixed
        target: {entity: arc1}
      - id: c_radius
        kind: radius
        target: {entity: arc1}
        value: 4.0
      - id: c_coin
        kind: coincident
        a: {entity: pt}
        b: {entity: arc1}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_point_on_arc", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    arc = geom["arc1"]
    cx, cy = arc["center"]
    r = arc["radius"]
    px, py = geom["pt"]["x"], geom["pt"]["y"]
    dist = math.hypot(px - cx, py - cy)
    assert abs(dist - r) < TOL


def test_coincident_line_to_line(sketch_log):
    """End of one line coincident with start of another (chain of two segments)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident line-to-line"
    initial:
      line_a: [0.0, 0.0, 3.0, 0.1]
      line_b: [3.2, 0.3, 6.0, 0.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_start
        kind: fixed
        target: {entity: line_a, point: start}
        x: 0.0
        y: 0.0
      - id: c_len_a
        kind: length
        target: {entity: line_a}
        value: 3.0
      - id: c_len_b
        kind: length
        target: {entity: line_b}
        value: 3.0
      - id: c_coin
        kind: coincident
        a: {entity: line_a, point: end}
        b: {entity: line_b, point: start}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_line_to_line", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    a_end = geom["line_a"]["end"]
    b_start = geom["line_b"]["start"]
    assert abs(a_end[0] - b_start[0]) < TOL
    assert abs(a_end[1] - b_start[1]) < TOL
    assert abs(math.hypot(geom["line_a"]["end"][0] - geom["line_a"]["start"][0],
                          geom["line_a"]["end"][1] - geom["line_a"]["start"][1]) - 3.0) < TOL
    assert abs(math.hypot(geom["line_b"]["end"][0] - geom["line_b"]["start"][0],
                          geom["line_b"]["end"][1] - geom["line_b"]["start"][1]) - 3.0) < TOL


def test_coincident_lines_collinear(sketch_log):
    """Two non-collinear line segments made collinear via coincident (no point ref).

    Both lines should lie on the same infinite line; their endpoints slide freely.
    Verified by checking that all four endpoints have the same perpendicular
    distance from the reference line (zero) and that the direction vectors are
    parallel.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident lines collinear"
    initial:
      line_a: [0.0, 0.0, 4.0, 0.0]
      line_b: [1.0, 1.5, 5.0, 1.2]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_a_start
        kind: fixed
        target: {entity: line_a, point: start}
        x: 0.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_len_a
        kind: length
        target: {entity: line_a}
        value: 4.0
      - id: c_len_b
        kind: length
        target: {entity: line_b}
        value: 3.0
      - id: c_collinear
        kind: coincident
        a: {entity: line_a}
        b: {entity: line_b}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_lines_collinear", yaml_str, result)

    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    # All four endpoints must lie on the same line (y == 0 here due to horizontal + fixed)
    for pt in [geom["line_a"]["start"], geom["line_a"]["end"],
               geom["line_b"]["start"], geom["line_b"]["end"]]:
        assert abs(pt[1]) < TOL

    # Directions must be parallel (cross product == 0)
    da = [geom["line_a"]["end"][0] - geom["line_a"]["start"][0],
          geom["line_a"]["end"][1] - geom["line_a"]["start"][1]]
    db = [geom["line_b"]["end"][0] - geom["line_b"]["start"][0],
          geom["line_b"]["end"][1] - geom["line_b"]["start"][1]]
    assert abs(da[0] * db[1] - da[1] * db[0]) < TOL

    # Lengths preserved
    assert abs(math.hypot(*da) - 4.0) < TOL
    assert abs(math.hypot(*db) - 3.0) < TOL


def test_tangent_degenerate_initial(sketch_log):
    """Tangent line-circle with a near-zero-length initial line converges quickly.

    The initial line1 start and end are only ~0.0005 units apart. Previously the
    tangent residual normalized the line direction vector, producing a 1/|line_length|
    factor in the Jacobian that made the optimizer ill-conditioned and caused it to
    exhaust its full evaluation budget (~10 s). The fix: use the unnormalized dot
    product, which has the same zero-set but well-conditioned gradients.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: Tangent line-circle
    initial:
      circle1:
        - 0.0696838394
        - -1.2097402902
        - 2.1436771388
      line1:
        - -1.357488
        - 0.389801
        - -1.3571180609
        - 0.3901309202
    entities:
      - id: circle1
        kind: circle
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_5
        kind: fixed
        target: $line1start
      - id: c_coincident_6
        kind: coincident
        a: $line1start
        b: $circle1
      - id: c_tangent_7
        kind: tangent
        a: $line1
        b: $circle1
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_tangent_degenerate_initial", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    # Must solve fast: well-conditioned Jacobian means <<100 ms, not seconds
    assert result["solve_ms"] < 500, f"solver too slow: {result['solve_ms']} ms"

    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line, circ = geom["line1"], geom["circle1"]

    # line start stays at its fixed position
    assert abs(line["start"][0] - (-1.357488)) < TOL
    assert abs(line["start"][1] - 0.389801) < TOL

    # line start is on the circle (coincident constraint)
    assert abs(length(line["start"], circ["center"]) - circ["radius"]) < TOL

    # line end is on the circle (tangent contact constraint)
    assert abs(length(line["end"], circ["center"]) - circ["radius"]) < TOL

    # line is tangent at line end: line direction perpendicular to radius
    assert is_tangent(line["start"], line["end"], circ["center"], line["end"]) < ATOL
