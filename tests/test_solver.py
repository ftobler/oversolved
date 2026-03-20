import math
from oversolve.solver import solve

TOL = 1e-5
ATOL = 1e-3  # angular / normalized-dot-product tolerance


def length(a, b):
    return math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)


def is_tangent(line_s, line_e, arc_center, arc_pt):
    """Normalized dot product of line direction and radius vector; should be ~0 for tangency."""
    ld = (line_e[0] - line_s[0], line_e[1] - line_s[1])
    rv = (arc_pt[0] - arc_center[0], arc_pt[1] - arc_center[1])
    dot = ld[0] * rv[0] + ld[1] * rv[1]
    return abs(dot) / (length(line_s, line_e) * length(arc_center, arc_pt))


def angle_between(a_s, a_e, b_s, b_e):
    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    cos = (da[0] * db[0] + da[1] * db[1]) / (length(a_s, a_e) * length(b_s, b_e))
    return math.degrees(math.acos(max(-1.0, min(1.0, cos))))


def test_horizontal_line_with_length(sketch_log):
    """A slightly tilted line should become horizontal with length 10."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Horizontal Line"
    initial:
      line1: [0.0, 1.5, 8.5, 3.5]
    entities:
      - id: line1
        kind: line_segment
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 10.0
"""
    result = solve(yaml_str)
    sketch_log["test_horizontal_line_with_length"] = result

    s = result["sketch_1"]["geometry"]["solved"]["line1"]["start"]
    e = result["sketch_1"]["geometry"]["solved"]["line1"]["end"]

    assert abs(s[1] - e[1]) < TOL, "line must be horizontal (same y)"
    length = math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2)
    assert abs(length - 10.0) < TOL, f"length must be 10, got {length}"


def test_perpendicular_lines_with_coincident_endpoint(sketch_log):
    """A horizontal base and vertical height share an endpoint and are perpendicular."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "L Shape"
    initial:
      base:   [0.0, 0.0, 7.0, 1.0]
      height: [7.5, 0.5, 5.5, 5.5]
    entities:
      - id: base
        kind: line_segment
      - id: height
        kind: line_segment
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: base}
      - id: c_join
        kind: coincident
        a: {entity: base,   point: end}
        b: {entity: height, point: start}
      - id: c_perp
        kind: perpendicular
        a: {entity: base}
        b: {entity: height}
      - id: c_len
        kind: length
        target: {entity: height}
        value: 5.0
"""
    result = solve(yaml_str)
    sketch_log["test_perpendicular_lines_with_coincident_endpoint"] = result

    base_s = result["sketch_1"]["geometry"]["solved"]["base"]["start"]
    base_e = result["sketch_1"]["geometry"]["solved"]["base"]["end"]
    height_s = result["sketch_1"]["geometry"]["solved"]["height"]["start"]
    height_e = result["sketch_1"]["geometry"]["solved"]["height"]["end"]

    assert abs(base_e[0] - height_s[0]) < TOL, "coincident x"
    assert abs(base_e[1] - height_s[1]) < TOL, "coincident y"

    db = (base_e[0] - base_s[0], base_e[1] - base_s[1])
    dh = (height_e[0] - height_s[0], height_e[1] - height_s[1])
    dot = db[0] * dh[0] + db[1] * dh[1]
    assert abs(dot) < TOL, f"lines must be perpendicular, dot={dot}"

    length = math.sqrt(dh[0] ** 2 + dh[1] ** 2)
    assert abs(length - 5.0) < TOL, f"height length must be 5, got {length}"


def test_two_lines_with_angle_constraint(sketch_log):
    """Two lines from a shared origin form a 45-degree angle; one has length 7."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Angled Lines"
    initial:
      line_a: [0.5, 1.0, 6.0, 3.0]
      line_b: [1.0, 0.5, 4.0, 6.5]
    entities:
      - id: line_a
        kind: line_segment
      - id: line_b
        kind: line_segment
    constraints:
      - id: c_origin
        kind: coincident
        a: {entity: line_a, point: start}
        b: {entity: line_b, point: start}
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_len_a
        kind: length
        target: {entity: line_a}
        value: 7.0
      - id: c_angle
        kind: angle
        a: {entity: line_a}
        b: {entity: line_b}
        value: 45.0
"""
    result = solve(yaml_str)
    sketch_log["test_two_lines_with_angle_constraint"] = result

    a_s = result["sketch_1"]["geometry"]["solved"]["line_a"]["start"]
    a_e = result["sketch_1"]["geometry"]["solved"]["line_a"]["end"]
    b_s = result["sketch_1"]["geometry"]["solved"]["line_b"]["start"]
    b_e = result["sketch_1"]["geometry"]["solved"]["line_b"]["end"]

    assert abs(a_s[0] - b_s[0]) < TOL, "shared origin x"
    assert abs(a_s[1] - b_s[1]) < TOL, "shared origin y"

    assert abs(a_s[1] - a_e[1]) < TOL, "line_a must be horizontal"

    len_a = math.sqrt((a_e[0] - a_s[0]) ** 2 + (a_e[1] - a_s[1]) ** 2)
    assert abs(len_a - 7.0) < TOL, f"line_a length must be 7, got {len_a}"

    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    cos_angle = (da[0] * db[0] + da[1] * db[1]) / (math.sqrt(da[0]
                                                             ** 2 + da[1]**2) * math.sqrt(db[0]**2 + db[1]**2))
    angle_deg = math.degrees(math.acos(max(-1.0, min(1.0, cos_angle))))
    assert abs(angle_deg - 45.0) < TOL, f"angle must be 45 deg, got {angle_deg}"


def test_rectangle(sketch_log):
    """Four line segments form an 8x5 rectangle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Rectangle 8x5"
    initial:
      bottom: [0.5, 0.5, 7.0, 1.0]
      right:  [7.0, 0.8, 7.8, 4.5]
      top:    [7.5, 4.5, 0.5, 4.0]
      left:   [0.5, 4.0, 0.3, 0.5]
    entities:
      - id: bottom
        kind: line_segment
      - id: right
        kind: line_segment
      - id: top
        kind: line_segment
      - id: left
        kind: line_segment
    constraints:
      - id: c_join_br
        kind: coincident
        a: {entity: bottom, point: end}
        b: {entity: right,  point: start}
      - id: c_join_rt
        kind: coincident
        a: {entity: right,  point: end}
        b: {entity: top,    point: start}
      - id: c_join_tl
        kind: coincident
        a: {entity: top,    point: end}
        b: {entity: left,   point: start}
      - id: c_join_lb
        kind: coincident
        a: {entity: left,   point: end}
        b: {entity: bottom, point: start}
      - id: c_horiz_bottom
        kind: horizontal
        target: {entity: bottom}
      - id: c_horiz_top
        kind: horizontal
        target: {entity: top}
      - id: c_vert_right
        kind: vertical
        target: {entity: right}
      - id: c_vert_left
        kind: vertical
        target: {entity: left}
      - id: c_width
        kind: length
        target: {entity: bottom}
        value: 8.0
      - id: c_height
        kind: length
        target: {entity: right}
        value: 5.0
"""
    result = solve(yaml_str)
    sketch_log["test_rectangle"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    b_s, b_e = sk["bottom"]["start"], sk["bottom"]["end"]
    r_s, r_e = sk["right"]["start"], sk["right"]["end"]
    t_s, t_e = sk["top"]["start"], sk["top"]["end"]
    l_s, l_e = sk["left"]["start"], sk["left"]["end"]

    # coincident joints
    assert length(b_e, r_s) < TOL
    assert length(r_e, t_s) < TOL
    assert length(t_e, l_s) < TOL
    assert length(l_e, b_s) < TOL

    # side lengths
    assert abs(length(b_s, b_e) - 8.0) < TOL, "width must be 8"
    assert abs(length(r_s, r_e) - 5.0) < TOL, "height must be 5"

    # all four angles are 90 degrees
    for as_, ae, bs, be, label in [
        (b_s, b_e, r_s, r_e, "bottom-right"),
        (r_s, r_e, t_s, t_e, "right-top"),
        (t_s, t_e, l_s, l_e, "top-left"),
        (l_s, l_e, b_s, b_e, "left-bottom"),
    ]:
        assert abs(angle_between(as_, ae, bs, be) - 90.0) < TOL, f"{label} must be 90 deg"


def test_equilateral_triangle(sketch_log):
    """Three equal-length sides form an equilateral triangle with side 6."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Equilateral Triangle"
    initial:
      a: [0.5, 0.5, 5.5, 1.0]
      b: [5.5, 0.8, 3.5, 4.5]
      c: [3.5, 4.5, 0.3, 0.5]
    entities:
      - id: a
        kind: line_segment
      - id: b
        kind: line_segment
      - id: c
        kind: line_segment
    constraints:
      - id: c_join_ab
        kind: coincident
        a: {entity: a, point: end}
        b: {entity: b, point: start}
      - id: c_join_bc
        kind: coincident
        a: {entity: b, point: end}
        b: {entity: c, point: start}
      - id: c_join_ca
        kind: coincident
        a: {entity: c, point: end}
        b: {entity: a, point: start}
      - id: c_horiz
        kind: horizontal
        target: {entity: a}
      - id: c_len_a
        kind: length
        target: {entity: a}
        value: 6.0
      - id: c_len_b
        kind: length
        target: {entity: b}
        value: 6.0
      - id: c_len_c
        kind: length
        target: {entity: c}
        value: 6.0
"""
    result = solve(yaml_str)
    sketch_log["test_equilateral_triangle"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    a_s, a_e = sk["a"]["start"], sk["a"]["end"]
    b_s, b_e = sk["b"]["start"], sk["b"]["end"]
    c_s, c_e = sk["c"]["start"], sk["c"]["end"]

    # coincident joints
    assert length(a_e, b_s) < TOL
    assert length(b_e, c_s) < TOL
    assert length(c_e, a_s) < TOL

    # all sides equal to 6
    assert abs(length(a_s, a_e) - 6.0) < TOL
    assert abs(length(b_s, b_e) - 6.0) < TOL
    assert abs(length(c_s, c_e) - 6.0) < TOL

    # angle between consecutive edge direction vectors is 120 deg
    # (interior angle 60 deg = 180 - 120; angle_between measures directions, not interior)
    assert abs(angle_between(a_s, a_e, b_s, b_e) - 120.0) < TOL
    assert abs(angle_between(b_s, b_e, c_s, c_e) - 120.0) < TOL
    assert abs(angle_between(c_s, c_e, a_s, a_e) - 120.0) < TOL


def test_pentagon(sketch_log):
    """Five equal-length sides with 72-degree turns form a regular pentagon with side 4."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Regular Pentagon"
    initial:
      e0: [0.0, 0.5, 3.5, 0.8]
      e1: [3.8, 0.5, 5.0, 3.2]
      e2: [5.2, 3.5, 2.5, 5.8]
      e3: [2.2, 5.8, -0.8, 3.5]
      e4: [-0.8, 3.5, 0.3, 0.3]
    entities:
      - id: e0
        kind: line_segment
      - id: e1
        kind: line_segment
      - id: e2
        kind: line_segment
      - id: e3
        kind: line_segment
      - id: e4
        kind: line_segment
    constraints:
      - id: c_join_01
        kind: coincident
        a: {entity: e0, point: end}
        b: {entity: e1, point: start}
      - id: c_join_12
        kind: coincident
        a: {entity: e1, point: end}
        b: {entity: e2, point: start}
      - id: c_join_23
        kind: coincident
        a: {entity: e2, point: end}
        b: {entity: e3, point: start}
      - id: c_join_34
        kind: coincident
        a: {entity: e3, point: end}
        b: {entity: e4, point: start}
      - id: c_join_40
        kind: coincident
        a: {entity: e4, point: end}
        b: {entity: e0, point: start}
      - id: c_horiz
        kind: horizontal
        target: {entity: e0}
      - id: c_len_0
        kind: length
        target: {entity: e0}
        value: 4.0
      - id: c_len_1
        kind: length
        target: {entity: e1}
        value: 4.0
      - id: c_len_2
        kind: length
        target: {entity: e2}
        value: 4.0
      - id: c_len_3
        kind: length
        target: {entity: e3}
        value: 4.0
      - id: c_len_4
        kind: length
        target: {entity: e4}
        value: 4.0
      - id: c_angle_01
        kind: angle
        a: {entity: e0}
        b: {entity: e1}
        value: 72.0
      - id: c_angle_12
        kind: angle
        a: {entity: e1}
        b: {entity: e2}
        value: 72.0
      - id: c_angle_23
        kind: angle
        a: {entity: e2}
        b: {entity: e3}
        value: 72.0
      - id: c_angle_34
        kind: angle
        a: {entity: e3}
        b: {entity: e4}
        value: 72.0
"""
    result = solve(yaml_str)
    sketch_log["test_pentagon"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    edges = [(sk[f"e{i}"]["start"], sk[f"e{i}"]["end"]) for i in range(5)]

    # coincident joints (including wrap-around)
    for i in range(5):
        s, e = edges[i]
        ns, _ = edges[(i + 1) % 5]
        assert length(e, ns) < TOL, f"joint e{i}->e{(i + 1) % 5} not coincident"

    # all sides equal to 4
    for i, (s, e) in enumerate(edges):
        assert abs(length(s, e) - 4.0) < TOL, f"e{i} length must be 4"

    # angle between each consecutive pair of edges is 72 degrees
    for i in range(5):
        a_s, a_e = edges[i]
        b_s, b_e = edges[(i + 1) % 5]
        deg = angle_between(a_s, a_e, b_s, b_e)
        assert abs(deg - 72.0) < TOL, f"angle at joint {i} must be 72 deg, got {deg}"


def test_circle_radius(sketch_log):
    """A circle with a radius constraint should reach the target radius."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Circle r=5"
    initial:
      circ: [3.0, 2.0, 3.5]
    entities:
      - id: circ
        kind: circle
    constraints:
      - id: c_radius
        kind: radius
        target: {entity: circ}
        value: 5.0
"""
    result = solve(yaml_str)
    sketch_log["test_circle_radius"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    assert abs(sk["circ"]["radius"] - 5.0) < TOL


def test_arc_coincident_with_line(sketch_log):
    """Arc start point coincident with end of a horizontal line; arc has fixed radius."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Line + Arc"
    initial:
      line1: [0.5, 0.5, 4.5, 0.3]
      arc1:  [5.5, 0.5, 2.8, 175, 260]
    entities:
      - id: line1
        kind: line_segment
      - id: arc1
        kind: arc
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 5.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: arc1,  point: start}
      - id: c_radius
        kind: radius
        target: {entity: arc1}
        value: 3.0
"""
    result = solve(yaml_str)
    sketch_log["test_arc_coincident_with_line"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    line_end = sk["line1"]["end"]
    arc_start = sk["arc1"]["start"]

    assert abs(length(sk["line1"]["start"], sk["line1"]["end"]) - 5.0) < TOL
    assert length(line_end, arc_start) < TOL
    assert abs(sk["arc1"]["radius"] - 3.0) < TOL


def test_circle_center_on_line_endpoint(sketch_log):
    """Circle center coincident with the end of a horizontal line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Line + Circle"
    initial:
      line1: [0.5, 0.5, 7.5, 0.5]
      circ:  [8.0, 0.5, 2.5]
    entities:
      - id: line1
        kind: line_segment
      - id: circ
        kind: circle
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 8.0
      - id: c_center
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: circ,  point: center}
      - id: c_radius
        kind: radius
        target: {entity: circ}
        value: 2.0
"""
    result = solve(yaml_str)
    sketch_log["test_circle_center_on_line_endpoint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    line_end = sk["line1"]["end"]
    center = sk["circ"]["center"]

    assert abs(length(sk["line1"]["start"], sk["line1"]["end"]) - 8.0) < TOL
    assert length(line_end, center) < TOL
    assert abs(sk["circ"]["radius"] - 2.0) < TOL


# ---------------------------------------------------------------------------
# Belt tests
# ---------------------------------------------------------------------------

def test_equal_belt(sketch_log):
    """Two arcs of equal radius connected by two tangent lines form a conveyor belt."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
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
        kind: line_segment
      - id: bot_line
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_equal_belt"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
        kind: line_segment
      - id: bot_line
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_unequal_belt"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    """Three equal arcs in a serpentine (S-path): middle arc wraps the opposite side."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Serpentine Belt"
    initial:
      arc_1: [0.2,  0.2, 2.1, 268,  92]
      arc_2: [8.1, -0.1, 2.0,  92, 272]
      arc_3: [16.1, 0.1, 1.9, 268,  92]
      seg_12: [0.1,  2.1, 8.1,  2.0]
      seg_23: [8.1, -2.0, 16.0,-2.0]
    entities:
      - id: arc_1
        kind: arc
      - id: arc_2
        kind: arc
      - id: arc_3
        kind: arc
      - id: seg_12
        kind: line_segment
      - id: seg_23
        kind: line_segment
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
        value: 2.0
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
    result = solve(yaml_str)
    sketch_log["test_serpentine_belt"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    a1, a2, a3 = sk["arc_1"], sk["arc_2"], sk["arc_3"]
    s12, s23 = sk["seg_12"], sk["seg_23"]

    for arc in [a1, a2, a3]:
        assert abs(arc["radius"] - 2.0) < TOL

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


# ---------------------------------------------------------------------------
# Collinear equal-segment tests
# ---------------------------------------------------------------------------

def test_collinear_equal_segments_single_dim(sketch_log):
    """Four collinear equal-length segments; one segment's length locks all."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Collinear x4 (single dim)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line_segment
      - id: s2
        kind: line_segment
      - id: s3
        kind: line_segment
      - id: s4
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_collinear_equal_segments_single_dim"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    label: "Collinear x4 (total span)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line_segment
      - id: s2
        kind: line_segment
      - id: s3
        kind: line_segment
      - id: s4
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_collinear_equal_segments_total_span"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    label: "Collinear x4 (partial span)"
    initial:
      s1: [0.3, 0.4, 2.8, 0.1]
      s2: [2.9, 0.2, 5.3, 0.3]
      s3: [5.4, 0.1, 7.8, 0.2]
      s4: [7.9, 0.3, 10.2, 0.1]
    entities:
      - id: s1
        kind: line_segment
      - id: s2
        kind: line_segment
      - id: s3
        kind: line_segment
      - id: s4
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_collinear_equal_segments_partial_span"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    segs = [sk[f"s{i}"] for i in range(1, 5)]

    partial = length(segs[1]["start"], segs[2]["end"])
    assert abs(partial - 6.0) < TOL

    for seg in segs:
        assert abs(length(seg["start"], seg["end"]) - 3.0) < TOL


# ---------------------------------------------------------------------------
# Constraint-status tests
# ---------------------------------------------------------------------------

def test_status_fully_constrained(sketch_log):
    """A horizontal line with fixed length is fully constrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Fully Constrained"
    initial:
      line1: [0.0, 1.5, 8.5, 3.5]
    entities:
      - id: line1
        kind: line_segment
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 10.0
"""
    result = solve(yaml_str)
    sketch_log["test_status_fully_constrained"] = result
    assert result["sketch_1"]["status"] == "fully_constrained"


def test_status_underconstrained(sketch_log):
    """A lone line segment with no constraints is underconstrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Underconstrained"
    initial:
      line1: [1.0, 2.0, 5.0, 6.0]
    entities:
      - id: line1
        kind: line_segment
    constraints: []
"""
    result = solve(yaml_str)
    sketch_log["test_status_underconstrained"] = result
    assert result["sketch_1"]["status"] == "underconstrained"


def test_status_overconstrained(sketch_log):
    """A line constrained to be both horizontal and vertical is overconstrained."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Overconstrained"
    initial:
      line1: [0.0, 1.5, 8.5, 3.5]
    entities:
      - id: line1
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_status_overconstrained"] = result
    assert result["sketch_1"]["status"] == "overconstrained"


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
    label: "Midpoint"
    initial:
      line1: [0.4, 0.4, 5.6, 0.6]
      circ:  [2.5, 1.5, 1.1]
    entities:
      - id: line1
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_midpoint_constraint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    label: "Normal"
    initial:
      arc1:  [3.5, 3.5, 2.8, 200, 290]
      line1: [0.3, 1.5, 1.2, 1.3]
    entities:
      - id: arc1
        kind: arc
      - id: line1
        kind: line_segment
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
        line: {entity: line1}
        arc:  {entity: arc1, point: start}
"""
    result = solve(yaml_str)
    sketch_log["test_normal_constraint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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


def test_concentric_constraint(sketch_log):
    """Two circles share the same center via concentric constraint."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
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
    result = solve(yaml_str)
    sketch_log["test_concentric_constraint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    label: "Fixed"
    initial:
      line1: [0.2, 0.2, 4.8, 0.3]
    entities:
      - id: line1
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_fixed_constraint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    label: "Point on midpoint"
    initial:
      line1: [0.3, 0.4, 3.8, 0.6]
      pt:    [2.1, 0.3]
    entities:
      - id: line1
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_point_on_midpoint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
    line, pt = sk["line1"], sk["pt"]
    mid_x = (line["start"][0] + line["end"][0]) / 2
    mid_y = (line["start"][1] + line["end"][1]) / 2

    assert abs(length(line["start"], line["end"]) - 4.0) < TOL
    assert abs(pt["x"] - mid_x) < TOL
    assert abs(pt["y"] - mid_y) < TOL


def test_rectangle_center_point(sketch_log):
    """Rectangle 6x4 with a point at its center, constrained via midpoints of two adjacent faces."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Rectangle center point"
    initial:
      top:    [0.3, 4.2, 6.1, 3.9]
      right:  [6.2, 4.1, 6.1,-0.1]
      bottom: [6.0,-0.2, 0.2, 0.1]
      left:   [0.1,-0.1, 0.2, 4.0]
      center: [3.1, 2.1]
    entities:
      - id: top
        kind: line_segment
      - id: right
        kind: line_segment
      - id: bottom
        kind: line_segment
      - id: left
        kind: line_segment
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
    result = solve(yaml_str)
    sketch_log["test_rectangle_center_point"] = result

    sk = result["sketch_1"]["geometry"]["solved"]
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
    result = solve(yaml_str)
    sketch_log["test_two_circles_partial_constraint"] = result

    sk = result["sketch_1"]["geometry"]["solved"]

    # circle_a: fully pinned — center and radius must match exactly
    assert abs(sk["circle_a"]["center"][0] - 3.0) < TOL
    assert abs(sk["circle_a"]["center"][1] - 4.0) < TOL
    assert abs(sk["circle_a"]["radius"] - 5.0) < TOL

    # circle_b: only radius constrained — center can be anywhere
    assert abs(sk["circle_b"]["radius"] - 2.0) < TOL

    # overall sketch is underconstrained (circle_b center is free)
    assert result["sketch_1"]["status"] == "underconstrained"
