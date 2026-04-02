import math
import yaml as yaml_module
from oversolved.solver import solve
from solver_helpers import TOL, ATOL, length, to_geom

# ---------------------------------------------------------------------------
# New constraint tests: midpoint, normal, concentric, fixed
# ---------------------------------------------------------------------------


def test_midpoint_constraint(sketch_log):
    """Circle center constrained to the midpoint of a horizontal line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Midpoint"
    initial:
      line1: [0.4, 0.4, 5.6, 0.6]
      circ:  [2.5, 1.5, 1.1]
    entities:
      - id: line1
        kind: line
      - id: circ
        kind: circle
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 6.0
      - id: c_mid
        kind: midpoint
        line: {entity: line1}
        point: {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_midpoint_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line, circ = sk["line1"], sk["circ"]
    mid_x = (line["start"][0] + line["end"][0]) / 2
    mid_y = (line["start"][1] + line["end"][1]) / 2

    assert abs(length(line["start"], line["end"]) - 6.0) < TOL
    assert abs(circ["center"][0] - mid_x) < TOL
    assert abs(circ["center"][1] - mid_y) < TOL


def test_normal_constraint(sketch_log):
    """Line endpoint coincident with arc start; line is normal to the arc there (radial direction)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Normal"
    initial:
      arc1:  [3.5, 3.5, 2.8, 200, 290]
      line1: [0.3, 1.5, 1.2, 1.3]
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line
    constraints:
      - id: c_r
        kind: radius
        target: {entity: arc1}
        value: 3.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: arc1,  point: start}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 2.0
      - id: c_normal
        kind: normal
        a: {entity: line1}
        b: {entity: arc1, point: start}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line, arc = sk["line1"], sk["arc1"]

    assert abs(arc["radius"] - 3.0) < TOL
    assert length(line["end"], arc["start"]) < TOL

    # line direction must be parallel to the radius vector at arc start
    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (
        arc["start"][0] -
        arc["center"][0],
        arc["start"][1] -
        arc["center"][1])
    cross = abs(ld[0] * rv[1] - ld[1] * rv[0])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert cross / norm < ATOL


def test_normal_constraint_arc(sketch_log):
    """Line endpoint coincident with arc start; line is normal (radial) to the arc."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Normal line-arc"
    initial:
      arc1:  [3.5, 3.5, 2.8, 200, 290]
      line1: [0.3, 1.5, 1.2, 1.3]
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line
    constraints:
      - id: c_r
        kind: radius
        target: {entity: arc1}
        value: 3.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: arc1,  point: start}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 2.0
      - id: c_normal
        kind: normal
        a: {entity: line1}
        b: {entity: arc1, point: start}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_constraint_arc", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line, arc = geom["line1"], geom["arc1"]

    assert abs(arc["radius"] - 3.0) < TOL
    assert length(line["end"], arc["start"]) < TOL

    # line direction must be parallel to the radius vector at arc start
    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (arc["start"][0] - arc["center"][0], arc["start"][1] - arc["center"][1])
    cross = abs(ld[0] * rv[1] - ld[1] * rv[0])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert cross / norm < ATOL


def test_normal_constraint_circle(sketch_log):
    """Line endpoint coincident with circle; line is normal (radial) to the circle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Normal line-circle"
    initial:
      circ:  [3.0, 3.0, 2.0]
      line1: [0.5, 3.2, 1.3, 3.1]
    entities:
      - id: circ
        kind: circle
      - id: line1
        kind: line
    constraints:
      - id: c_fix_circ
        kind: fixed
        target: {entity: circ}
        x: 3.0
        y: 3.0
      - id: c_radius
        kind: radius
        target: {entity: circ}
        value: 2.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: circ}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 2.0
      - id: c_normal
        kind: normal
        a: {entity: line1}
        b: {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_constraint_circle", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    line, circ = geom["line1"], geom["circ"]

    # line end must be on the circle
    assert abs(length(line["end"], circ["center"]) - circ["radius"]) < TOL

    # line direction must be parallel to the radius vector at the contact point
    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (line["end"][0] - circ["center"][0], line["end"][1] - circ["center"][1])
    cross = abs(ld[0] * rv[1] - ld[1] * rv[0])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert cross / norm < ATOL


def test_normal_line_circle(sketch_log):
    """Line normal to a circle (normal constraint on line and circle)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Normal line-circle"
    initial:
      circ:  [0.0, 0.0, 3.0]
      line1: [-1.5, 3.1, 1.5, 3.1]
    entities:
      - id: circ
        kind: circle
      - id: line1
        kind: line
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
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: circ}
      - id: c_perp
        kind: normal
        a: {entity: line1}
        b: {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_line_circle", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    line, circ = geom["line1"], geom["circ"]

    # line end must be on the circle
    assert abs(length(line["end"], circ["center"]) - circ["radius"]) < TOL

    # perpendicular = line direction is parallel to radius (normal to tangent)
    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (line["end"][0] - circ["center"][0], line["end"][1] - circ["center"][1])
    cross = abs(ld[0] * rv[1] - ld[1] * rv[0])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert cross / norm < ATOL


def test_tangent_line_circle_ab_keys(sketch_log):
    """kind: tangent with a/b keys (frontend format) works the same as line/arc keys."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Tangent a/b keys"
    initial:
      circ:  [0.0, 0.0, 3.0]
      line1: [-2.0, 2.8, 2.0, 3.1]
    entities:
      - id: circ
        kind: circle
      - id: line1
        kind: line
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
      - id: c_tangent
        kind: tangent
        a: {entity: line1}
        b: {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_tangent_line_circle_ab_keys", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line, circ = geom["line1"], geom["circ"]

    assert abs(length(line["end"], circ["center"]) - circ["radius"]) < TOL

    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (line["end"][0] - circ["center"][0], line["end"][1] - circ["center"][1])
    dot = abs(ld[0] * rv[0] + ld[1] * rv[1])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert dot / norm < ATOL


def test_tangent_line_circle(sketch_log):
    """Line tangent to a circle at the contact point (tangent constraint)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Tangent line-circle"
    initial:
      circ:  [0.0, 0.0, 3.0]
      line1: [-2.0, 2.8, 2.0, 3.1]
    entities:
      - id: circ
        kind: circle
      - id: line1
        kind: line
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
      - id: c_tangent
        kind: tangent
        line: {entity: line1}
        arc:  {entity: circ}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_tangent_line_circle", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    line, circ = geom["line1"], geom["circ"]

    # line end must be on the circle
    assert abs(length(line["end"], circ["center"]) - circ["radius"]) < TOL

    # tangent = line direction perpendicular to radius at contact
    ld = (line["end"][0] - line["start"][0], line["end"][1] - line["start"][1])
    rv = (line["end"][0] - circ["center"][0], line["end"][1] - circ["center"][1])
    dot = abs(ld[0] * rv[0] + ld[1] * rv[1])
    norm = length((0, 0), ld) * length((0, 0), rv)
    assert dot / norm < ATOL


def test_query_string_constraints(sketch_log):
    """Constraints using query string syntax ($entity, $entitypoint) work the same
    as old-style {entity: ..., point: ...} dicts."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Query Strings"
    initial:
      base:   [0.0, 0.0, 7.0, 1.0]
      height: [7.5, 0.5, 5.5, 5.5]
    entities:
      - id: base
        kind: line
      - id: height
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$base"
      - id: c_join
        kind: coincident
        a: "$baseend"
        b: "$heightstart"
      - id: c_perp
        kind: normal
        a: "$base"
        b: "$height"
      - id: c_len
        kind: length
        target: "$height"
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_query_string_constraints", yaml_str, result)
    assert result["status"] in ("fully_constrained", "underconstrained")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    base_e = geom["base"][2:4]
    height_s = geom["height"][0:2]
    height_e = geom["height"][2:4]
    assert abs(base_e[0] - height_s[0]) < TOL, "coincident x"
    assert abs(base_e[1] - height_s[1]) < TOL, "coincident y"
    dh = (height_e[0] - height_s[0], height_e[1] - height_s[1])
    length = math.sqrt(dh[0] ** 2 + dh[1] ** 2)
    assert abs(length - 5.0) < TOL, f"height length must be 5, got {length}"


def test_concentric_constraint(sketch_log):
    """Two circles share the same center via concentric constraint."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Concentric"
    initial:
      circ_s: [1.5, 1.5, 2.2]
      circ_l: [2.5, 2.5, 3.1]
    entities:
      - id: circ_s
        kind: circle
      - id: circ_l
        kind: circle
    constraints:
      - id: c_r_s
        kind: radius
        target: {entity: circ_s}
        value: 2.0
      - id: c_r_l
        kind: radius
        target: {entity: circ_l}
        value: 3.0
      - id: c_conc
        kind: concentric
        a: {entity: circ_s}
        b: {entity: circ_l}
      - id: c_fix
        kind: fixed
        target: {entity: circ_s}
        x: 0.0
        y: 0.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_concentric_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    cs, cl = sk["circ_s"], sk["circ_l"]

    assert abs(cs["radius"] - 2.0) < TOL
    assert abs(cl["radius"] - 3.0) < TOL
    assert length(cs["center"], cl["center"]) < TOL
    assert abs(cs["center"][0] - 0.0) < TOL
    assert abs(cs["center"][1] - 0.0) < TOL


def test_fixed_constraint(sketch_log):
    """Line start fixed at origin; horizontal with length 5."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Fixed"
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line = sk["line1"]

    assert abs(line["start"][0] - 0.0) < TOL
    assert abs(line["start"][1] - 0.0) < TOL
    assert abs(length(line["start"], line["end"]) - 5.0) < TOL


# ---------------------------------------------------------------------------
# Point primitive tests
# ---------------------------------------------------------------------------

def test_point_on_midpoint(sketch_log):
    """A point entity constrained to the midpoint of a line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Point on midpoint"
    initial:
      line1: [0.3, 0.4, 3.8, 0.6]
      pt:    [2.1, 0.3]
    entities:
      - id: line1
        kind: line
      - id: pt
        kind: point
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 4.0
      - id: c_mid
        kind: midpoint
        line: {entity: line1}
        point: {entity: pt}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_point_on_midpoint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line, pt = sk["line1"], sk["pt"]
    mid_x = (line["start"][0] + line["end"][0]) / 2
    mid_y = (line["start"][1] + line["end"][1]) / 2

    assert abs(length(line["start"], line["end"]) - 4.0) < TOL
    assert abs(pt["x"] - mid_x) < TOL
    assert abs(pt["y"] - mid_y) < TOL


def test_midpoint_of_two_points(sketch_log):
    """A point constrained to the midpoint between two other points."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Midpoint of two points"
    initial:
      pt_a:   [0.0, 0.0]
      pt_b:   [4.0, 2.0]
      pt_mid: [3.0, 5.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_mid
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_fix_b
        kind: fixed
        target: {entity: pt_b}
        x: 4.0
        y: 2.0
      - id: c_mid
        kind: midpoint
        point_a: {entity: pt_a}
        point_b: {entity: pt_b}
        point: {entity: pt_mid}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_midpoint_of_two_points", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    ax, ay = sk["pt_a"]["x"], sk["pt_a"]["y"]
    bx, by = sk["pt_b"]["x"], sk["pt_b"]["y"]
    mx, my = sk["pt_mid"]["x"], sk["pt_mid"]["y"]

    assert abs(mx - (ax + bx) / 2) < TOL
    assert abs(my - (ay + by) / 2) < TOL


def test_midpoint_of_two_points_axis_x(sketch_log):
    """Point x-coordinate centered between two points at different y values (axis: x only).
    pt_a=(0,0), pt_b=(6,4) — midpoint x=3, midpoint y=2.
    pt_mid.y is constrained by horizontal to pt_a (y=0), not y=2, proving axis:x
    leaves y untouched."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Midpoint of two points axis x"
    initial:
      pt_a:   [0.0, 0.0]
      pt_b:   [6.0, 4.0]
      pt_mid: [0.5, 0.1]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_mid
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_fix_b
        kind: fixed
        target: {entity: pt_b}
        x: 6.0
        y: 4.0
      - id: c_horiz
        kind: horizontal
        a: {entity: pt_mid}
        b: {entity: pt_a}
      - id: c_mid
        kind: midpoint
        point_a: {entity: pt_a}
        point_b: {entity: pt_b}
        point: {entity: pt_mid}
        axis: x
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_midpoint_of_two_points_axis_x", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    ax, ay = sk["pt_a"]["x"], sk["pt_a"]["y"]
    bx = sk["pt_b"]["x"]
    mx, my = sk["pt_mid"]["x"], sk["pt_mid"]["y"]

    assert abs(mx - (ax + bx) / 2) < TOL   # x at midpoint (3.0)
    assert abs(my - ay) < TOL              # y matches pt_a, NOT midpoint y (2.0)


def test_midpoint_of_line_endpoints(sketch_log):
    """Point constrained to midpoint between start of one line and end of another."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Midpoint of line endpoints"
    initial:
      line_a: [0.0, 0.0, 2.0, 0.0]
      line_b: [6.0, 0.0, 8.0, 0.0]
      pt_mid: [9.0, 9.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
      - id: pt_mid
        kind: point
    constraints:
      - id: c_fix_a
        kind: fixed
        target: {entity: line_a, point: end}
        x: 2.0
        y: 0.0
      - id: c_fix_b
        kind: fixed
        target: {entity: line_b, point: start}
        x: 6.0
        y: 0.0
      - id: c_mid
        kind: midpoint
        point_a: {entity: line_a, point: end}
        point_b: {entity: line_b, point: start}
        point: {entity: pt_mid}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_midpoint_of_line_endpoints", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    ax, ay = sk["line_a"]["end"][0], sk["line_a"]["end"][1]
    bx, by = sk["line_b"]["start"][0], sk["line_b"]["start"][1]
    mx, my = sk["pt_mid"]["x"], sk["pt_mid"]["y"]

    assert abs(mx - (ax + bx) / 2) < TOL
    assert abs(my - (ay + by) / 2) < TOL


def test_rectangle_center_point(sketch_log):
    """Rectangle 6x4 with a point at its center, constrained via midpoints of two adjacent faces."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Rectangle center point"
    initial:
      top:    [0.3, 4.2, 6.1, 3.9]
      right:  [6.2, 4.1, 6.1,-0.1]
      bottom: [6.0,-0.2, 0.2, 0.1]
      left:   [0.1,-0.1, 0.2, 4.0]
      center: [3.1, 2.1]
    entities:
      - id: top
        kind: line
      - id: right
        kind: line
      - id: bottom
        kind: line
      - id: left
        kind: line
      - id: center
        kind: point
    constraints:
      - id: c_horiz_top
        kind: horizontal
        target: {entity: top}
      - id: c_horiz_bot
        kind: horizontal
        target: {entity: bottom}
      - id: c_vert_l
        kind: vertical
        target: {entity: left}
      - id: c_vert_r
        kind: vertical
        target: {entity: right}
      - id: c_join_tr
        kind: coincident
        a: {entity: top,    point: end}
        b: {entity: right,  point: start}
      - id: c_join_rb
        kind: coincident
        a: {entity: right,  point: end}
        b: {entity: bottom, point: start}
      - id: c_join_bl
        kind: coincident
        a: {entity: bottom, point: end}
        b: {entity: left,   point: start}
      - id: c_join_lt
        kind: coincident
        a: {entity: left,   point: end}
        b: {entity: top,    point: start}
      - id: c_width
        kind: length
        target: {entity: top}
        value: 6.0
      - id: c_height
        kind: length
        target: {entity: left}
        value: 4.0
      - id: c_fix
        kind: fixed
        target: {entity: top, point: start}
        x: 0.0
        y: 4.0
      - id: c_mid_x
        kind: midpoint
        line:  {entity: top}
        point: {entity: center}
        axis: x
      - id: c_mid_y
        kind: midpoint
        line:  {entity: left}
        point: {entity: center}
        axis: y
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_rectangle_center_point", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    top, left, center = sk["top"], sk["left"], sk["center"]

    assert abs(length(top["start"], top["end"]) - 6.0) < TOL
    assert abs(length(left["start"], left["end"]) - 4.0) < TOL

    expected_x = (top["start"][0] + top["end"][0]) / 2
    expected_y = (left["start"][1] + left["end"][1]) / 2
    assert abs(center["x"] - expected_x) < TOL
    assert abs(center["y"] - expected_y) < TOL
    assert abs(center["x"] - 3.0) < TOL
    assert abs(center["y"] - 2.0) < TOL


def test_two_circles_partial_constraint(sketch_log):
    """Two circles in one sketch: one fully constrained, one only radius-constrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Two Circles"
    initial:
      circle_a: [3.0, 4.0, 5.0]
      circle_b: [8.0, 2.0, 2.0]
    entities:
      - id: circle_a
        kind: circle
      - id: circle_b
        kind: circle
    constraints:
      - id: c_a_fix
        kind: fixed
        target: {entity: circle_a}
        x: 3.0
        y: 4.0
      - id: c_a_radius
        kind: radius
        target: {entity: circle_a}
        value: 5.0
      - id: c_b_radius
        kind: radius
        target: {entity: circle_b}
        value: 2.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_two_circles_partial_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # circle_a: fully pinned — center and radius must match exactly
    assert abs(sk["circle_a"][0:2][0] - 3.0) < TOL
    assert abs(sk["circle_a"][0:2][1] - 4.0) < TOL
    assert abs(sk["circle_a"][2] - 5.0) < TOL

    # circle_b: only radius constrained — center can be anywhere
    assert abs(sk["circle_b"][2] - 2.0) < TOL

    # overall sketch is underconstrained (circle_b center is free)
    assert result["status"] == "underconstrained"


def test_parallel_constraint(sketch_log):
    """Two lines constrained to be parallel."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Parallel Lines"
    initial:
      line_a: [0.0, 0.0, 10.0, 2.0]
      line_b: [0.0, 5.0, 10.0, 8.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_a_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_a_len
        kind: length
        target: {entity: line_a}
        value: 10.0
      - id: c_parallel
        kind: parallel
        a: {entity: line_a}
        b: {entity: line_b}
      - id: c_b_fix
        kind: fixed
        target: {entity: line_b, point: start}
        x: 0.0
        y: 5.0
      - id: c_b_len
        kind: length
        target: {entity: line_b}
        value: 10.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_parallel_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # line_a is horizontal with length 10
    assert abs(sk["line_a"][0:2][1] - sk["line_a"][2:4][1]) < TOL
    assert abs(length(sk["line_a"][0:2], sk["line_a"][2:4]) - 10.0) < TOL

    # line_b is parallel to line_a (same y-delta)
    dy_a = sk["line_a"][2:4][1] - sk["line_a"][0:2][1]
    dy_b = sk["line_b"][2:4][1] - sk["line_b"][0:2][1]
    assert abs(dy_a - dy_b) < TOL

    # line_b has length 10
    assert abs(length(sk["line_b"][0:2], sk["line_b"][2:4]) - 10.0) < TOL

    # line_b starts at (0, 5)
    assert abs(sk["line_b"][0:2][0] - 0.0) < TOL
    assert abs(sk["line_b"][0:2][1] - 5.0) < TOL
