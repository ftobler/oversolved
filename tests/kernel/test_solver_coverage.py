import math
import yaml as yaml_module
from oversolved.kernel.solver import solve
from solver_helpers import TOL, ATOL, length, is_tangent, to_geom


# ── Tests for previously untested / under-tested areas ──


def test_vertical_ab_keys(sketch_log):
    """vertical constraint with a:/b: keys aligns two points to the same x-coordinate."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Vertical a/b keys"
    initial:
      pt_a: [2.0, 0.0]
      pt_b: [3.5, 4.8]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 2.0
        y: 0.0
      - id: c_vert
        kind: vertical
        a: {entity: pt_a}
        b: {entity: pt_b}
      - id: c_dist
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_b}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_vertical_ab_keys", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    ax = geom["pt_a"]["x"]
    bx = geom["pt_b"]["x"]
    ay = geom["pt_a"]["y"]
    by = geom["pt_b"]["y"]
    assert abs(ax - bx) < TOL, f"vertical a/b: x-coords must match, got {ax} vs {bx}"
    assert abs(math.hypot(bx - ax, by - ay) - 5.0) < TOL


def test_horizontal_ab_keys(sketch_log):
    """horizontal constraint with a:/b: keys aligns two points to the same y-coordinate."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Horizontal a/b keys"
    initial:
      pt_a: [0.0, 3.0]
      pt_b: [4.8, 3.5]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 3.0
      - id: c_horiz
        kind: horizontal
        a: {entity: pt_a}
        b: {entity: pt_b}
      - id: c_dist
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_b}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_horizontal_ab_keys", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    ay = geom["pt_a"]["y"]
    by = geom["pt_b"]["y"]
    assert abs(ay - by) < TOL, f"horizontal a/b: y-coords must match, got {ay} vs {by}"


def test_line_distance_vertex_b(sketch_log):
    """line_distance constraint where b references a vertex (endpoint of a line)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Line distance vertex b"
    initial:
      base: [0.0, 0.0, 8.0, 0.0]
      arm:  [2.0, 4.5, 6.0, 4.5]
    entities:
      - id: base
        kind: line
      - id: arm
        kind: line
    constraints:
      - id: c_fix_base
        kind: fixed
        target: {entity: base, point: start}
        x: 0.0
        y: 0.0
      - id: c_horiz_base
        kind: horizontal
        target: {entity: base}
      - id: c_len_base
        kind: length
        target: {entity: base}
        value: 8.0
      - id: c_horiz_arm
        kind: horizontal
        target: {entity: arm}
      - id: c_dist
        kind: line_distance
        a: {entity: base}
        b: {entity: arm, point: end}
        value: 3.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_line_distance_vertex_b", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    # base is along y=0; arm end should be exactly 3 units above it
    base_start_y = geom["base"]["start"][1]
    arm_end_y = geom["arm"]["end"][1]
    assert abs(arm_end_y - base_start_y - 3.0) < TOL, (
        f"perpendicular distance from base to arm end must be 3, got {arm_end_y - base_start_y}"
    )


def test_point_distance_circle_centers(sketch_log):
    """point_distance between two circle entities constrains the distance between centers."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Point distance circle centers"
    initial:
      circ_a: [0.0, 0.0, 1.5]
      circ_b: [4.5, 0.5, 1.5]
    entities:
      - id: circ_a
        kind: circle
      - id: circ_b
        kind: circle
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: circ_a}
        x: 0.0
        y: 0.0
      - id: c_r_a
        kind: radius
        target: {entity: circ_a}
        value: 1.0
      - id: c_r_b
        kind: radius
        target: {entity: circ_b}
        value: 1.0
      - id: c_horiz
        kind: horizontal
        a: {entity: circ_a}
        b: {entity: circ_b}
      - id: c_dist
        kind: point_distance
        a: {entity: circ_a}
        b: {entity: circ_b}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_point_distance_circle_centers", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    ca = geom["circ_a"]["center"]
    cb = geom["circ_b"]["center"]
    dist = length(ca, cb)
    assert abs(dist - 5.0) < TOL, f"distance between circle centers must be 5, got {dist}"
    assert abs(ca[1] - cb[1]) < TOL, "circles must be horizontally aligned (same y)"


def test_diameter_render_output(sketch_log):
    """diameter constraint produces correct render output fields."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Diameter render"
    initial:
      circ: [0.0, 0.0, 2.5]
    entities:
      - id: circ
        kind: circle
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: circ}
        x: 0.0
        y: 0.0
      - id: c_diam
        kind: diameter
        target: {entity: circ}
        value: 6.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_diameter_render_output", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    render = result["constraints"]["c_diam"]["render"]
    assert render["kind"] == "dim_diameter"
    assert "p1" in render
    assert "p2" in render
    assert render["value"] == 6.0
    assert render["entity"] == "circ"
    # center fixed at (0,0), radius = 3.0 → p1=[-3,0], p2=[3,0]
    r = 3.0
    assert abs(render["p1"][0] - (-r)) < TOL
    assert abs(render["p1"][1] - 0.0) < TOL
    assert abs(render["p2"][0] - r) < TOL
    assert abs(render["p2"][1] - 0.0) < TOL


def test_radius_render_output(sketch_log):
    """radius constraint produces correct render output fields for a circle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Radius render"
    initial:
      circ: [0.0, 0.0, 2.5]
    entities:
      - id: circ
        kind: circle
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: circ}
        x: 0.0
        y: 0.0
      - id: c_radius
        kind: radius
        target: {entity: circ}
        value: 3.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_radius_render_output", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    render = result["constraints"]["c_radius"]["render"]
    assert render["kind"] == "dim_radius"
    assert "p1" in render
    assert "p2" in render
    assert render["value"] == 3.0
    assert render["entity"] == "circ"
    # p1 = center = (0,0); p2 = edge = (r, 0) for circle with no "start"
    assert abs(render["p1"][0] - 0.0) < TOL
    assert abs(render["p1"][1] - 0.0) < TOL
    assert abs(render["p2"][0] - 3.0) < TOL
    assert abs(render["p2"][1] - 0.0) < TOL


def test_concentric_two_arcs(sketch_log):
    """concentric constraint between two arcs forces their centers to coincide."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Concentric arcs"
    initial:
      arc_inner: [1.5, 1.5, 1.0,  0.0, 180.0]
      arc_outer: [2.5, 2.5, 2.5,  0.0, 180.0]
    entities:
      - id: arc_inner
        kind: arc
      - id: arc_outer
        kind: arc
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: arc_inner}
      - id: c_r_inner
        kind: radius
        target: {entity: arc_inner}
        value: 1.0
      - id: c_r_outer
        kind: radius
        target: {entity: arc_outer}
        value: 2.5
      - id: c_conc
        kind: concentric
        a: {entity: arc_inner}
        b: {entity: arc_outer}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_concentric_two_arcs", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    inner_center = geom["arc_inner"]["center"]
    outer_center = geom["arc_outer"]["center"]
    assert length(inner_center, outer_center) < TOL, (
        f"arc centers must coincide, got {inner_center} vs {outer_center}"
    )
    assert abs(geom["arc_inner"]["radius"] - 1.0) < TOL
    assert abs(geom["arc_outer"]["radius"] - 2.5) < TOL


def test_fixed_render_output(sketch_log):
    """fixed constraint render output contains all required fields."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Fixed render"
    initial:
      line1: [1.0, 2.0, 5.0, 2.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fix
        kind: fixed
        target: {entity: line1, point: start}
        x: 1.0
        y: 2.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_render_output", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    render = result["constraints"]["c_fix"]["render"]
    assert render["kind"] == "symbol_fixed"
    assert "at" in render
    assert "x" in render
    assert "y" in render
    assert render["entity"] == "line1"
    assert abs(render["at"][0] - 1.0) < TOL
    assert abs(render["at"][1] - 2.0) < TOL
    assert abs(render["x"] - 1.0) < TOL
    assert abs(render["y"] - 2.0) < TOL


def test_normal_render_entity_a_is_arc(sketch_log):
    """normal constraint render uses arc start as 'at' when entity a is an arc."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Normal render a=arc"
    initial:
      arc1:  [0.0, 0.0, 3.0,  0.0, 90.0]
      line1: [2.5, 0.5, 5.0, 0.5]
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line
    constraints:
      - id: c_fix_arc
        kind: fixed
        target: {entity: arc1}
      - id: c_r
        kind: radius
        target: {entity: arc1}
        value: 3.0
      - id: c_normal
        kind: normal
        a: {entity: arc1, point: start}
        b: {entity: line1}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_render_entity_a_is_arc", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    render = result["constraints"]["c_normal"]["render"]
    assert render["kind"] == "symbol_normal"
    assert "at" in render
    assert render["entity"] == "arc1"


def test_coincident_two_points(sketch_log):
    """coincident between two point entities forces them to the same location."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Coincident two points"
    initial:
      pt_a: [0.0, 0.0]
      pt_b: [3.0, 4.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_coin
        kind: coincident
        a: {entity: pt_a}
        b: {entity: pt_b}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_coincident_two_points", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    ax, ay = geom["pt_a"]["x"], geom["pt_a"]["y"]
    bx, by = geom["pt_b"]["x"], geom["pt_b"]["y"]
    assert abs(ax - bx) < TOL, f"coincident points must share x: {ax} vs {bx}"
    assert abs(ay - by) < TOL, f"coincident points must share y: {ay} vs {by}"
    assert abs(ax - 0.0) < TOL
    assert abs(ay - 0.0) < TOL


def test_tangent_line_arc_ab_keys(sketch_log):
    """tangent constraint with a/b keys works for a line tangent to an arc."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Tangent line-arc a/b keys"
    initial:
      arc1:  [0.0, 0.0, 3.0,  0.0, 90.0]
      line1: [-0.5, 3.1, 2.5, 3.0]
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line
    constraints:
      - id: c_fix_arc
        kind: fixed
        target: {entity: arc1}
      - id: c_r
        kind: radius
        target: {entity: arc1}
        value: 3.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: start}
        b: {entity: arc1,  point: end}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 3.0
      - id: c_tangent
        kind: tangent
        a: {entity: line1}
        b: {entity: arc1, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_tangent_line_arc_ab_keys", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    line = geom["line1"]
    arc = geom["arc1"]

    # line start must be at arc end
    assert length(line["start"], arc["end"]) < TOL

    # tangent: line direction perpendicular to radius at arc end
    assert is_tangent(line["start"], line["end"], arc["center"], arc["end"]) < ATOL


def test_constraint_residual_values(sketch_log):
    """Solved constraints have near-zero residuals; they are present in result['constraints']."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Residual check"
    initial:
      line1: [0.2, 0.3, 9.8, 0.5]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 10.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_constraint_residual_values", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    constraints_out = result["constraints"]
    assert "c_horiz" in constraints_out
    assert "c_len" in constraints_out
    assert "residual" in constraints_out["c_horiz"]
    assert "residual" in constraints_out["c_len"]
    assert abs(constraints_out["c_horiz"]["residual"]) < TOL
    assert abs(constraints_out["c_len"]["residual"]) < TOL


def test_per_entity_status_inspection(sketch_log):
    """result['features'] contains per-entity constraint status for each entity."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Per-entity status"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
      circ:  [7.0, 0.0, 2.0]
    entities:
      - id: line1
        kind: line
      - id: circ
        kind: circle
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
      - id: c_r
        kind: radius
        target: {entity: circ}
        value: 2.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_per_entity_status_inspection", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    features = result["features"]
    assert "line1" in features
    assert "circ" in features
    assert "status" in features["line1"]
    assert "status" in features["circ"]

    # line1 is fully constrained (fixed start + horizontal + length pin all 4 params)
    assert features["line1"]["status"] == "fully_constrained"
    # circ has only radius constrained; center is free → underconstrained
    assert features["circ"]["status"] == "underconstrained"


def test_superfluous_constraint_flagged(sketch_log):
    """A duplicate constraint is flagged as superfluous in result['constraints']."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Superfluous constraint"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_horiz_dup
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_superfluous_constraint_flagged", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")

    constraints_out = result["constraints"]
    assert "superfluous" in constraints_out["c_horiz"]
    assert "superfluous" in constraints_out["c_horiz_dup"]
    assert "superfluous" in constraints_out["c_len"]

    # greedy algorithm: first constraint is removed (superfluous) when the
    # second copy already covers the same row; second copy is kept
    assert constraints_out["c_horiz"]["superfluous"]
    assert not constraints_out["c_horiz_dup"]["superfluous"]
    assert not constraints_out["c_len"]["superfluous"]


def test_fixed_circle_center_via_query_string(sketch_log):
    """fixed applied to circle center via $entitycenter query string constrains center correctly."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Fixed circle center query"
    initial:
      circ: [3.5, 2.5, 2.0]
    entities:
      - id: circ
        kind: circle
    constraints:
      - id: c_fix
        kind: fixed
        target: "$circcenter"
        x: 3.0
        y: 2.0
      - id: c_r
        kind: radius
        target: {entity: circ}
        value: 2.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_circle_center_via_query_string", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    center = geom["circ"]["center"]
    assert abs(center[0] - 3.0) < TOL, f"circle center x must be 3.0, got {center[0]}"
    assert abs(center[1] - 2.0) < TOL, f"circle center y must be 2.0, got {center[1]}"
    assert abs(geom["circ"]["radius"] - 2.0) < TOL


def test_fixed_constraint_unresolvable_query_string(sketch_log):
    """Constraints referencing a non-existent entity via query string are silently
    dropped - they must NOT cause a 'string indices must be integers' exception.

    Regression: $circle1 and $circle1center don't resolve (no circle1 entity),
    so both fixed constraints were left as raw strings after _pre_resolve.
    Later c["target"]["entity"] on the string raised TypeError.
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
      arc1:
        - 0.013638
        - 0.049086
        - 0.378366
        - -0.592784
        - -160.092221
      line1:
        - -0.73911
        - -0.519418
        - -0.550477
        - 0.734078
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_4
        kind: fixed
        target: $circle1
      - id: c_fixed_5
        kind: fixed
        target: $circle1center
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_constraint_unresolvable_query_string", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")


def test_superfluous_duplicate_horizontal(sketch_log):
    """Two horizontal constraints on the same line: one is superfluous."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 5, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_h1
        kind: horizontal
        target: $line1
      - id: c_h2
        kind: horizontal
        target: $line1
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_superfluous_duplicate_horizontal", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    constraints = result.get("constraints", {})
    assert "c_h1" in constraints
    assert "c_h2" in constraints
    # Exactly one of the two duplicate horizontals must be flagged superfluous
    superfluous = [cid for cid, c in constraints.items() if c.get("superfluous")]
    assert len(superfluous) == 1
    assert superfluous[0] in ("c_h1", "c_h2")


def test_superfluous_redundant_length(sketch_log):
    """A fully-fixed line (via fixed constraint) with an additional length constraint:
    the length is superfluous because the endpoints are already pinned."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0, 0, 3, 0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_start
        kind: fixed
        target: $line1start
        x: 0
        y: 0
      - id: c_fixed_end
        kind: fixed
        target: $line1end
        x: 3
        y: 0
      - id: c_len
        kind: length
        target: $line1
        value: 3
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_superfluous_redundant_length", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    constraints = result.get("constraints", {})
    assert constraints.get("c_len", {}).get("superfluous") is True
    assert constraints.get("c_fixed_start", {}).get("superfluous") is not True
    assert constraints.get("c_fixed_end", {}).get("superfluous") is not True


def test_superfluous_none_on_minimal_rect(sketch_log):
    """A minimal rectangle (4 lines, 4 coincident, 2 equal-length, horizontal, vertical)
    has no superfluous constraints."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      lA: [0, 0, 4, 0]
      lB: [4, 0, 4, 3]
      lC: [4, 3, 0, 3]
      lD: [0, 3, 0, 0]
    entities:
      - id: lA
        kind: line
      - id: lB
        kind: line
      - id: lC
        kind: line
      - id: lD
        kind: line
    constraints:
      - id: c_coin_ab
        kind: coincident
        a: $lAend
        b: $lBstart
      - id: c_coin_bc
        kind: coincident
        a: $lBend
        b: $lCstart
      - id: c_coin_cd
        kind: coincident
        a: $lCend
        b: $lDstart
      - id: c_coin_da
        kind: coincident
        a: $lDend
        b: $lAstart
      - id: c_eq_ac
        kind: equal_length
        a: $lA
        b: $lC
      - id: c_eq_bd
        kind: equal_length
        a: $lB
        b: $lD
      - id: c_h
        kind: horizontal
        target: $lA
      - id: c_v
        kind: vertical
        target: $lB
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_superfluous_none_on_minimal_rect", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    constraints = result.get("constraints", {})
    superfluous = [cid for cid, c in constraints.items() if c.get("superfluous")]
    assert superfluous == [], f"Expected no superfluous, got: {superfluous}"
