import math
from oversolve.solver import solve

TOL = 1e-5


def length(a, b):
    return math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)


def angle_between(a_s, a_e, b_s, b_e):
    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    cos = (da[0]*db[0] + da[1]*db[1]) / (length(a_s, a_e) * length(b_s, b_e))
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

    s = result["sketch_1"]["solved"]["line1"]["start"]
    e = result["sketch_1"]["solved"]["line1"]["end"]

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

    base_s = result["sketch_1"]["solved"]["base"]["start"]
    base_e = result["sketch_1"]["solved"]["base"]["end"]
    height_s = result["sketch_1"]["solved"]["height"]["start"]
    height_e = result["sketch_1"]["solved"]["height"]["end"]

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

    a_s = result["sketch_1"]["solved"]["line_a"]["start"]
    a_e = result["sketch_1"]["solved"]["line_a"]["end"]
    b_s = result["sketch_1"]["solved"]["line_b"]["start"]
    b_e = result["sketch_1"]["solved"]["line_b"]["end"]

    assert abs(a_s[0] - b_s[0]) < TOL, "shared origin x"
    assert abs(a_s[1] - b_s[1]) < TOL, "shared origin y"

    assert abs(a_s[1] - a_e[1]) < TOL, "line_a must be horizontal"

    len_a = math.sqrt((a_e[0] - a_s[0]) ** 2 + (a_e[1] - a_s[1]) ** 2)
    assert abs(len_a - 7.0) < TOL, f"line_a length must be 7, got {len_a}"

    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    cos_angle = (da[0] * db[0] + da[1] * db[1]) / (math.sqrt(da[0]**2 + da[1]**2) * math.sqrt(db[0]**2 + db[1]**2))
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

    sk = result["sketch_1"]["solved"]
    b_s, b_e = sk["bottom"]["start"], sk["bottom"]["end"]
    r_s, r_e = sk["right"]["start"],  sk["right"]["end"]
    t_s, t_e = sk["top"]["start"],    sk["top"]["end"]
    l_s, l_e = sk["left"]["start"],   sk["left"]["end"]

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

    sk = result["sketch_1"]["solved"]
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

    sk = result["sketch_1"]["solved"]
    edges = [(sk[f"e{i}"]["start"], sk[f"e{i}"]["end"]) for i in range(5)]

    # coincident joints (including wrap-around)
    for i in range(5):
        s, e = edges[i]
        ns, _ = edges[(i + 1) % 5]
        assert length(e, ns) < TOL, f"joint e{i}->e{(i+1)%5} not coincident"

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

    sk = result["sketch_1"]["solved"]
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
      arc1:  [5.5, 0.5, 2.8, 175, 90]
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

    sk = result["sketch_1"]["solved"]
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

    sk = result["sketch_1"]["solved"]
    line_end = sk["line1"]["end"]
    center = sk["circ"]["center"]

    assert abs(length(sk["line1"]["start"], sk["line1"]["end"]) - 8.0) < TOL
    assert length(line_end, center) < TOL
    assert abs(sk["circ"]["radius"] - 2.0) < TOL
