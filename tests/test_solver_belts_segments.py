import yaml as yaml_module
from oversolved.solver import solve
from solver_helpers import TOL, ATOL, length, is_tangent, to_geom

# ── Belt tests ──


def test_equal_belt(sketch_log):
    """Two arcs of equal radius connected by two tangent lines form a conveyor belt."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Equal Belt r=2"
    initial:
      arc_l:    [0.2,  0.3, 2.2,  88, 272]
      arc_r:    [7.0, -0.2, 2.1, 268,  92]
      top_line: [0.1,  2.1, 6.9,  1.9]
      bot_line: [7.1, -2.1, 0.1, -1.9]
    entities:
      - id: arc_l
        kind: arc
      - id: arc_r
        kind: arc
      - id: top_line
        kind: line
      - id: bot_line
        kind: line
    constraints:
      - id: c_r_l
        kind: radius
        target: {entity: arc_l}
        value: 2.0
      - id: c_r_r
        kind: radius
        target: {entity: arc_r}
        value: 2.0
      - id: c_join_tl
        kind: coincident
        a: {entity: arc_l,    point: start}
        b: {entity: top_line, point: start}
      - id: c_join_tr
        kind: coincident
        a: {entity: top_line, point: end}
        b: {entity: arc_r,    point: end}
      - id: c_join_br
        kind: coincident
        a: {entity: arc_r,    point: start}
        b: {entity: bot_line, point: start}
      - id: c_join_bl
        kind: coincident
        a: {entity: bot_line, point: end}
        b: {entity: arc_l,    point: end}
      - id: c_tan_tl
        kind: tangent
        line: {entity: top_line}
        arc:  {entity: arc_l, point: start}
      - id: c_tan_tr
        kind: tangent
        line: {entity: top_line}
        arc:  {entity: arc_r, point: end}
      - id: c_tan_br
        kind: tangent
        line: {entity: bot_line}
        arc:  {entity: arc_r, point: start}
      - id: c_tan_bl
        kind: tangent
        line: {entity: bot_line}
        arc:  {entity: arc_l, point: end}
      - id: c_horiz
        kind: horizontal
        target: {entity: top_line}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_equal_belt", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    al, ar = sk["arc_l"], sk["arc_r"]
    tl, bl = sk["top_line"], sk["bot_line"]

    assert abs(al["radius"] - 2.0) < TOL
    assert abs(ar["radius"] - 2.0) < TOL

    assert length(al["start"], tl["start"]) < TOL
    assert length(tl["end"], ar["end"]) < TOL
    assert length(ar["start"], bl["start"]) < TOL
    assert length(bl["end"], al["end"]) < TOL

    assert is_tangent(tl["start"], tl["end"], al["center"], al["start"]) < ATOL
    assert is_tangent(tl["start"], tl["end"], ar["center"], ar["end"]) < ATOL
    assert is_tangent(bl["start"], bl["end"], ar["center"], ar["start"]) < ATOL
    assert is_tangent(bl["start"], bl["end"], al["center"], al["end"]) < ATOL


def test_unequal_belt(sketch_log):
    """Two arcs of different radii (r=2 and r=3) connected by two tangent lines."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Unequal Belt r=1,3"
    initial:
      arc_l:    [0.2,  0.1, 2.1,  92, 268]
      arc_r:    [11.9,-0.2, 3.1, 268,  92]
      top_line: [-0.2, 2.0, 11.7,  3.1]
      bot_line: [11.7,-3.1, -0.2, -2.0]
    entities:
      - id: arc_l
        kind: arc
      - id: arc_r
        kind: arc
      - id: top_line
        kind: line
      - id: bot_line
        kind: line
    constraints:
      - id: c_r_l
        kind: radius
        target: {entity: arc_l}
        value: 1.0
      - id: c_r_r
        kind: radius
        target: {entity: arc_r}
        value: 3.0
      - id: c_join_tl
        kind: coincident
        a: {entity: arc_l,    point: end}
        b: {entity: top_line, point: start}
      - id: c_join_tr
        kind: coincident
        a: {entity: top_line, point: end}
        b: {entity: arc_r,    point: start}
      - id: c_join_br
        kind: coincident
        a: {entity: arc_r,    point: end}
        b: {entity: bot_line, point: start}
      - id: c_join_bl
        kind: coincident
        a: {entity: bot_line, point: end}
        b: {entity: arc_l,    point: start}
      - id: c_tan_tl
        kind: tangent
        line: {entity: top_line}
        arc:  {entity: arc_l, point: end}
      - id: c_tan_tr
        kind: tangent
        line: {entity: top_line}
        arc:  {entity: arc_r, point: start}
      - id: c_tan_br
        kind: tangent
        line: {entity: bot_line}
        arc:  {entity: arc_r, point: end}
      - id: c_tan_bl
        kind: tangent
        line: {entity: bot_line}
        arc:  {entity: arc_l, point: start}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_unequal_belt", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    al, ar = sk["arc_l"], sk["arc_r"]
    tl, bl = sk["top_line"], sk["bot_line"]

    assert abs(al["radius"] - 1.0) < TOL
    assert abs(ar["radius"] - 3.0) < TOL

    assert length(al["end"], tl["start"]) < TOL
    assert length(tl["end"], ar["start"]) < TOL
    assert length(ar["end"], bl["start"]) < TOL
    assert length(bl["end"], al["start"]) < TOL

    assert is_tangent(tl["start"], tl["end"], al["center"], al["end"]) < ATOL
    assert is_tangent(tl["start"], tl["end"], ar["center"], ar["start"]) < ATOL
    assert is_tangent(bl["start"], bl["end"], ar["center"], ar["end"]) < ATOL
    assert is_tangent(bl["start"], bl["end"], al["center"], al["start"]) < ATOL


def test_serpentine_belt(sketch_log):
    """Three equal arcs in a serpentine (S-path): corrected geometry.

    Arc 1 (left): center below, curves from 92° to 268° (top at 90°)
    Arc 2 (middle): center above, curves from 272° to 92° (wraps around)
    Arc 3 (right): center below, curves from 92° to 268° (top at 90°)
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Serpentine Belt"
    initial:
      arc_1: [0.2,  -2.1, 2.1,  92, 268]
      arc_2: [8.1,  2.1, 2.0, 272,  92]
      arc_3: [-1.0,  1.5, 3.0,  92, 268]
      seg_12: [0.1,  2.0, 8.1,  2.0]
      seg_23: [8.1, -2.0, -1.0,-2.0]
    entities:
      - id: arc_1
        kind: arc
      - id: arc_2
        kind: arc
      - id: arc_3
        kind: arc
      - id: seg_12
        kind: line
      - id: seg_23
        kind: line
    constraints:
      - id: c_r1
        kind: radius
        target: {entity: arc_1}
        value: 2.0
      - id: c_r2
        kind: radius
        target: {entity: arc_2}
        value: 2.0
      - id: c_r3
        kind: radius
        target: {entity: arc_3}
        value: 3.0
      - id: c_join_1_12
        kind: coincident
        a: {entity: arc_1,  point: end}
        b: {entity: seg_12, point: start}
      - id: c_join_12_2
        kind: coincident
        a: {entity: seg_12, point: end}
        b: {entity: arc_2,  point: start}
      - id: c_join_2_23
        kind: coincident
        a: {entity: arc_2,  point: end}
        b: {entity: seg_23, point: start}
      - id: c_join_23_3
        kind: coincident
        a: {entity: seg_23, point: end}
        b: {entity: arc_3,  point: start}
      - id: c_tan_1_12
        kind: tangent
        line: {entity: seg_12}
        arc:  {entity: arc_1, point: end}
      - id: c_tan_12_2
        kind: tangent
        line: {entity: seg_12}
        arc:  {entity: arc_2, point: start}
      - id: c_tan_2_23
        kind: tangent
        line: {entity: seg_23}
        arc:  {entity: arc_2, point: end}
      - id: c_tan_23_3
        kind: tangent
        line: {entity: seg_23}
        arc:  {entity: arc_3, point: start}
      - id: c_horiz
        kind: horizontal
        target: {entity: seg_12}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_serpentine_belt", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    a1, a2, a3 = sk["arc_1"], sk["arc_2"], sk["arc_3"]
    s12, s23 = sk["seg_12"], sk["seg_23"]

    assert abs(a1["radius"] - 2.0) < TOL
    assert abs(a2["radius"] - 2.0) < TOL
    assert abs(a3["radius"] - 3.0) < TOL

    assert length(a1["end"], s12["start"]) < TOL
    assert length(s12["end"], a2["start"]) < TOL
    assert length(a2["end"], s23["start"]) < TOL
    assert length(s23["end"], a3["start"]) < TOL

    assert is_tangent(s12["start"], s12["end"], a1["center"], a1["end"]) < ATOL
    assert is_tangent(
        s12["start"],
        s12["end"],
        a2["center"],
        a2["start"]) < ATOL
    assert is_tangent(s23["start"], s23["end"], a2["center"], a2["end"]) < ATOL
    assert is_tangent(
        s23["start"],
        s23["end"],
        a3["center"],
        a3["start"]) < ATOL


# ── Collinear equal-segment tests ──

def test_collinear_equal_segments_single_dim(sketch_log):
    """Four collinear equal-length segments; one segment's length locks all."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Collinear x4 (single dim)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line
      - id: s2
        kind: line
      - id: s3
        kind: line
      - id: s4
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: s1}
      - id: c_join_12
        kind: coincident
        a: {entity: s1, point: end}
        b: {entity: s2, point: start}
      - id: c_join_23
        kind: coincident
        a: {entity: s2, point: end}
        b: {entity: s3, point: start}
      - id: c_join_34
        kind: coincident
        a: {entity: s3, point: end}
        b: {entity: s4, point: start}
      - id: c_horiz_2
        kind: horizontal
        target: {entity: s2}
      - id: c_horiz_3
        kind: horizontal
        target: {entity: s3}
      - id: c_horiz_4
        kind: horizontal
        target: {entity: s4}
      - id: c_eq_12
        kind: equal_length
        a: {entity: s1}
        b: {entity: s2}
      - id: c_eq_23
        kind: equal_length
        a: {entity: s2}
        b: {entity: s3}
      - id: c_eq_34
        kind: equal_length
        a: {entity: s3}
        b: {entity: s4}
      - id: c_len
        kind: length
        target: {entity: s1}
        value: 3.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_collinear_equal_segments_single_dim", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    segs = [sk[f"s{i}"] for i in range(1, 5)]

    for seg in segs:
        assert abs(length(seg["start"], seg["end"]) - 3.0) < TOL

    for i in range(3):
        assert length(segs[i]["end"], segs[i + 1]["start"]) < TOL


def test_collinear_equal_segments_total_span(sketch_log):
    """Four collinear equal-length segments; one dimension spans all four."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Collinear x4 (total span)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line
      - id: s2
        kind: line
      - id: s3
        kind: line
      - id: s4
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: s1}
      - id: c_join_12
        kind: coincident
        a: {entity: s1, point: end}
        b: {entity: s2, point: start}
      - id: c_join_23
        kind: coincident
        a: {entity: s2, point: end}
        b: {entity: s3, point: start}
      - id: c_join_34
        kind: coincident
        a: {entity: s3, point: end}
        b: {entity: s4, point: start}
      - id: c_horiz_2
        kind: horizontal
        target: {entity: s2}
      - id: c_horiz_3
        kind: horizontal
        target: {entity: s3}
      - id: c_horiz_4
        kind: horizontal
        target: {entity: s4}
      - id: c_eq_12
        kind: equal_length
        a: {entity: s1}
        b: {entity: s2}
      - id: c_eq_23
        kind: equal_length
        a: {entity: s2}
        b: {entity: s3}
      - id: c_eq_34
        kind: equal_length
        a: {entity: s3}
        b: {entity: s4}
      - id: c_total_span
        kind: point_distance
        a: {entity: s1, point: start}
        b: {entity: s4, point: end}
        value: 12.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_collinear_equal_segments_total_span", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    segs = [sk[f"s{i}"] for i in range(1, 5)]

    total = length(segs[0]["start"], segs[3]["end"])
    assert abs(total - 12.0) < TOL

    for seg in segs:
        assert abs(length(seg["start"], seg["end"]) - 3.0) < TOL


def test_collinear_equal_segments_partial_span(sketch_log):
    """Four collinear equal-length segments; one dimension spans the middle two."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Collinear x4 (partial span)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line
      - id: s2
        kind: line
      - id: s3
        kind: line
      - id: s4
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: s1}
      - id: c_join_12
        kind: coincident
        a: {entity: s1, point: end}
        b: {entity: s2, point: start}
      - id: c_join_23
        kind: coincident
        a: {entity: s2, point: end}
        b: {entity: s3, point: start}
      - id: c_join_34
        kind: coincident
        a: {entity: s3, point: end}
        b: {entity: s4, point: start}
      - id: c_horiz_2
        kind: horizontal
        target: {entity: s2}
      - id: c_horiz_3
        kind: horizontal
        target: {entity: s3}
      - id: c_horiz_4
        kind: horizontal
        target: {entity: s4}
      - id: c_eq_12
        kind: equal_length
        a: {entity: s1}
        b: {entity: s2}
      - id: c_eq_23
        kind: equal_length
        a: {entity: s2}
        b: {entity: s3}
      - id: c_eq_34
        kind: equal_length
        a: {entity: s3}
        b: {entity: s4}
      - id: c_partial_span
        kind: point_distance
        a: {entity: s2, point: start}
        b: {entity: s3, point: end}
        value: 6.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_collinear_equal_segments_partial_span", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    segs = [sk[f"s{i}"] for i in range(1, 5)]

    partial = length(segs[1]["start"], segs[2]["end"])
    assert abs(partial - 6.0) < TOL

    for seg in segs:
        assert abs(length(seg["start"], seg["end"]) - 3.0) < TOL


# ── Constraint-status tests ──

def test_status_fully_constrained(sketch_log):
    """A horizontal line with fixed length and a fixed point is fully constrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Fully Constrained"
    initial:
      line1: [0.0, 0.0, 10.0, 0.0]
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
        value: 10.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_status_fully_constrained", yaml_str, result)
    assert result["status"] == "fully_constrained"


def test_status_underconstrained(sketch_log):
    """A lone line segment with no constraints is underconstrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Underconstrained"
    initial:
      line1: [1.0, 2.0, 5.0, 6.0]
    entities:
      - id: line1
        kind: line
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_status_underconstrained", yaml_str, result)
    assert result["status"] == "underconstrained"


def test_status_overconstrained(sketch_log):
    """A line constrained to be both horizontal and vertical is overconstrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Overconstrained"
    initial:
      line1: [0.0, 1.5, 8.5, 3.5]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_vert
        kind: vertical
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 10.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_status_overconstrained", yaml_str, result)
    assert result["status"] == "overconstrained"
