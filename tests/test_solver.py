import math
from oversolve.solver import solve

TOL = 1e-5


def test_horizontal_line_with_length():
    """A slightly tilted line should become horizontal with length 10."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Horizontal Line"
    initial:
      line1: [0.0, 0.1, 9.5, 0.3]
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
    s = result["sketch_1"]["line1"]["start"]
    e = result["sketch_1"]["line1"]["end"]

    assert abs(s[1] - e[1]) < TOL, "line must be horizontal (same y)"
    length = math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2)
    assert abs(length - 10.0) < TOL, f"length must be 10, got {length}"


def test_perpendicular_lines_with_coincident_endpoint():
    """A horizontal base and vertical height share an endpoint and are perpendicular."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "L Shape"
    initial:
      base:   [0.0, 0.0, 8.0, 0.1]
      height: [8.1, 0.0, 8.1, 4.5]
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
    base_s = result["sketch_1"]["base"]["start"]
    base_e = result["sketch_1"]["base"]["end"]
    height_s = result["sketch_1"]["height"]["start"]
    height_e = result["sketch_1"]["height"]["end"]

    assert abs(base_e[0] - height_s[0]) < TOL, "coincident x"
    assert abs(base_e[1] - height_s[1]) < TOL, "coincident y"

    db = (base_e[0] - base_s[0], base_e[1] - base_s[1])
    dh = (height_e[0] - height_s[0], height_e[1] - height_s[1])
    dot = db[0] * dh[0] + db[1] * dh[1]
    assert abs(dot) < TOL, f"lines must be perpendicular, dot={dot}"

    length = math.sqrt(dh[0] ** 2 + dh[1] ** 2)
    assert abs(length - 5.0) < TOL, f"height length must be 5, got {length}"


def test_two_lines_with_angle_constraint():
    """Two lines from a shared origin form a 45-degree angle; one has length 7."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    label: "Angled Lines"
    initial:
      line_a: [0.0, 0.0, 7.0, 0.1]
      line_b: [0.0, 0.0, 4.8, 5.1]
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
    a_s = result["sketch_1"]["line_a"]["start"]
    a_e = result["sketch_1"]["line_a"]["end"]
    b_s = result["sketch_1"]["line_b"]["start"]
    b_e = result["sketch_1"]["line_b"]["end"]

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
