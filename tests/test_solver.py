import math
import yaml as yaml_module
from oversolved.solver import solve

TOL = 1e-5
ATOL = 1e-3  # angular / normalized-dot-product tolerance


class Geom:
    """Wrapper to make flat array geometry readable in tests.

    Converts geometry arrays to accessible properties:
    - line [x1,y1,x2,y2] -> .start, .end
    - circle [cx,cy,r] -> .center, .radius
    - arc [cx,cy,r,a0,a1] -> .center, .radius, .angle_start, .angle_end, .start, .end
    - point [x,y] -> .x, .y
    """

    def __init__(self, geom_dict, entity_kind):
        self._data = geom_dict
        self._kind = entity_kind

    def __getitem__(self, key):
        """Support dict-style and slice access: .["start"], ["radius"], [0:2], etc."""
        if isinstance(key, slice):
            return self._data[key]
        elif isinstance(key, int):
            return self._data[key]
        elif key == "start":
            return self.start
        elif key == "end":
            return self.end
        elif key == "center":
            return self.center
        elif key == "radius":
            return self.radius
        elif key == "angle_start":
            return self.angle_start
        elif key == "angle_end":
            return self.angle_end
        elif key == "x":
            return self.x
        elif key == "y":
            return self.y
        else:
            raise KeyError(f"Unknown key: {key}")

    @property
    def start(self):
        if self._kind == "line":
            return list(self._data[0:2])
        elif self._kind == "arc":
            # Arc: [cx, cy, r, a_start, a_end], compute start point from angle
            cx, cy, r, a_start = self._data[0], self._data[1], self._data[2], self._data[3]
            return [cx + r * math.cos(math.radians(a_start)), cy + r * math.sin(math.radians(a_start))]
        raise AttributeError(f"start not available for {self._kind}")

    @property
    def end(self):
        if self._kind == "line":
            return list(self._data[2:4])
        elif self._kind == "arc":
            # Arc: [cx, cy, r, a_start, a_end], compute end point from angle
            cx, cy, r, a_end = self._data[0], self._data[1], self._data[2], self._data[4]
            return [cx + r * math.cos(math.radians(a_end)), cy + r * math.sin(math.radians(a_end))]
        raise AttributeError(f"end not available for {self._kind}")

    @property
    def center(self):
        if self._kind in ("circle", "arc"):
            return list(self._data[0:2])
        raise AttributeError(f"center not available for {self._kind}")

    @property
    def radius(self):
        if self._kind in ("circle", "arc"):
            return self._data[2]
        raise AttributeError(f"radius not available for {self._kind}")

    @property
    def angle_start(self):
        if self._kind == "arc":
            return self._data[3]
        raise AttributeError(f"angle_start not available for {self._kind}")

    @property
    def angle_end(self):
        if self._kind == "arc":
            return self._data[4]
        raise AttributeError(f"angle_end not available for {self._kind}")

    @property
    def x(self):
        if self._kind == "point":
            return self._data[0]
        raise AttributeError(f"x not available for {self._kind}")

    @property
    def y(self):
        if self._kind == "point":
            return self._data[1]
        raise AttributeError(f"y not available for {self._kind}")

    def __contains__(self, key):
        """Support 'key' in geom checks."""
        if key in ("start", "end", "center", "radius", "angle_start", "angle_end", "x", "y"):
            try:
                # Try to access the property; if it raises AttributeError, it's not available
                getattr(self, key)
                return True
            except AttributeError:
                return False
        return False

    def get(self, key):
        """Support .get("construction") for construction flag."""
        if key == "construction":
            # Construction flag is not in the array; would need to be passed separately
            return None
        raise AttributeError(f"get({key}) not supported")


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


def to_geom(geom_flat, entities):
    """Convert flat array geometry to readable dict format.

    Entities should be a list of {id, kind, ...} dicts from the YAML.
    Returns {entity_id: Geom wrapper object}
    """
    entities_dict = {e["id"]: e for e in entities}
    result = {}
    for eid, params in geom_flat.items():
        if eid in entities_dict:
            result[eid] = Geom(params, entities_dict[eid]["kind"])
    return result


def test_missing_plane_is_error():
    """A sketch without a plane reference must fail with a descriptive error."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch1
    kind: sketch
    entities: []
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch1"]
    assert result["status"] == "exception"
    assert "plane" in result["exception"].lower()


def test_unknown_plane_is_error():
    """A sketch referencing a non-existent plane must also fail."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch1
    kind: sketch
    plane: "@does_not_exist"
    entities: []
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch1"]
    assert result["status"] == "exception"
    assert "plane" in result["exception"].lower()


def test_horizontal_line_with_length(sketch_log):
    """A slightly tilted line should become horizontal with length 10."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Horizontal Line"
    initial:
      line1: [0.0, 1.5, 8.5, 3.5]
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
    sketch_log("test_horizontal_line_with_length", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line1 = geom["line1"]
    s = line1[0:2]
    e = line1[2:4]

    assert abs(s[1] - e[1]) < TOL, "line must be horizontal (same y)"
    length_val = math.sqrt((e[0] - s[0]) ** 2 + (e[1] - s[1]) ** 2)
    assert abs(length_val - 10.0) < TOL, f"length must be 10, got {length_val}"


def test_normal_lines_with_coincident_endpoint(sketch_log):
    """A horizontal base and vertical height share an endpoint and are normal (perpendicular) to each other."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "L Shape"
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
        target: {entity: base}
      - id: c_join
        kind: coincident
        a: {entity: base,   point: end}
        b: {entity: height, point: start}
      - id: c_perp
        kind: normal
        a: {entity: base}
        b: {entity: height}
      - id: c_len
        kind: length
        target: {entity: height}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_normal_lines_with_coincident_endpoint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    base_s = geom["base"][0:2]
    base_e = geom["base"][2:4]
    height_s = geom["height"][0:2]
    height_e = geom["height"][2:4]

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
    plane: "@builtin_plane_front"
    label: "Angled Lines"
    initial:
      line_a: [0.5, 1.0, 6.0, 3.0]
      line_b: [1.0, 0.5, 4.0, 6.5]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_two_lines_with_angle_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    a_s = geom["line_a"][0:2]
    a_e = geom["line_a"][2:4]
    b_s = geom["line_b"][0:2]
    b_e = geom["line_b"][2:4]

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
    plane: "@builtin_plane_front"
    label: "Rectangle 8x5"
    initial:
      bottom: [0.5, 0.5, 7.0, 1.0]
      right:  [7.0, 0.8, 7.8, 4.5]
      top:    [7.5, 4.5, 0.5, 4.0]
      left:   [0.5, 4.0, 0.3, 0.5]
    entities:
      - id: bottom
        kind: line
      - id: right
        kind: line
      - id: top
        kind: line
      - id: left
        kind: line
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_rectangle", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    b_s, b_e = sk["bottom"][0:2], sk["bottom"][2:4]
    r_s, r_e = sk["right"][0:2], sk["right"][2:4]
    t_s, t_e = sk["top"][0:2], sk["top"][2:4]
    l_s, l_e = sk["left"][0:2], sk["left"][2:4]

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
    plane: "@builtin_plane_front"
    label: "Equilateral Triangle"
    initial:
      a: [0.5, 0.5, 5.5, 1.0]
      b: [5.5, 0.8, 3.5, 4.5]
      c: [3.5, 4.5, 0.3, 0.5]
    entities:
      - id: a
        kind: line
      - id: b
        kind: line
      - id: c
        kind: line
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_equilateral_triangle", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    a_s, a_e = sk["a"][0:2], sk["a"][2:4]
    b_s, b_e = sk["b"][0:2], sk["b"][2:4]
    c_s, c_e = sk["c"][0:2], sk["c"][2:4]

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
    plane: "@builtin_plane_front"
    label: "Regular Pentagon"
    initial:
      e0: [0.0, 0.5, 3.5, 0.8]
      e1: [3.8, 0.5, 5.0, 3.2]
      e2: [5.2, 3.5, 2.5, 5.8]
      e3: [2.2, 5.8, -0.8, 3.5]
      e4: [-0.8, 3.5, 0.3, 0.3]
    entities:
      - id: e0
        kind: line
      - id: e1
        kind: line
      - id: e2
        kind: line
      - id: e3
        kind: line
      - id: e4
        kind: line
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_pentagon", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
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
    plane: "@builtin_plane_front"
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_circle_radius", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    assert abs(sk["circ"][2] - 5.0) < TOL


def test_arc_coincident_with_line(sketch_log):
    """Arc start point coincident with end of a horizontal line; arc has fixed radius."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Line + Arc"
    initial:
      line1: [0.5, 0.5, 4.5, 0.3]
      arc1:  [5.5, 0.5, 2.8, 175, 260]
    entities:
      - id: line1
        kind: line
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_arc_coincident_with_line", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line_end = sk["line1"][2:4]
    arc_start = sk["arc1"].start

    assert abs(length(sk["line1"][0:2], sk["line1"][2:4]) - 5.0) < TOL
    assert length(line_end, arc_start) < TOL
    assert abs(sk["arc1"][2] - 3.0) < TOL


def test_circle_center_on_line_endpoint(sketch_log):
    """Circle center coincident with the end of a horizontal line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Line + Circle"
    initial:
      line1: [0.5, 0.5, 7.5, 0.5]
      circ:  [8.0, 0.5, 2.5]
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
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_circle_center_on_line_endpoint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom
    line_end = sk["line1"][2:4]
    center = sk["circ"][0:2]

    assert abs(length(sk["line1"][0:2], sk["line1"][2:4]) - 8.0) < TOL
    assert length(line_end, center) < TOL
    assert abs(sk["circ"][2] - 2.0) < TOL


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


# ---------------------------------------------------------------------------
# Constraint-status tests
# ---------------------------------------------------------------------------

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


def test_construction_geometry(sketch_log):
    """Construction geometry entities are marked and solved correctly."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Construction Geometry"
    initial:
      main_line: [0.0, 0.0, 10.0, 0.0]
      construction_line: [0.0, 5.0, 10.0, 5.0]
      construction_circle: [5.0, 5.0, 2.0]
      construction_pt: [7.5, 7.5]
    entities:
      - id: main_line
        kind: line
      - id: construction_line
        kind: line
        construction: true
      - id: construction_circle
        kind: circle
        construction: true
      - id: construction_pt
        kind: point
        construction: true
    constraints:
      - id: c_main_horiz
        kind: horizontal
        target: {entity: main_line}
      - id: c_main_len
        kind: length
        target: {entity: main_line}
        value: 10.0
      - id: c_main_fix
        kind: fixed
        target: {entity: main_line, point: start}
        x: 0.0
        y: 0.0
      - id: c_const_horiz
        kind: horizontal
        target: {entity: construction_line}
      - id: c_const_len
        kind: length
        target: {entity: construction_line}
        value: 10.0
      - id: c_const_circle_rad
        kind: radius
        target: {entity: construction_circle}
        value: 2.0
      - id: c_const_pt_fix
        kind: fixed
        target: {entity: construction_pt}
        x: 7.5
        y: 7.5
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_construction_geometry", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify main entities are solved correctly
    assert abs(length(sk["main_line"][0:2], sk["main_line"][2:4]) - 10.0) < TOL
    assert abs(sk["main_line"][0:2][0] - 0.0) < TOL
    assert abs(sk["main_line"][0:2][1] - 0.0) < TOL

    # Verify construction line is solved
    assert abs(length(sk["construction_line"][0:2], sk["construction_line"][2:4]) - 10.0) < TOL

    # Note: construction flag is not preserved in flat array format
    # The construction metadata would need to be stored separately if needed for UI
    # assert sk["construction_line"].get("construction")
    # assert sk["construction_circle"].get("construction")
    # assert sk["construction_pt"].get("construction")

    # Note: construction flag is not available in new format
    # assert not sk["main_line"].get("construction")

    # Verify construction circle radius is correct
    assert abs(sk["construction_circle"][2] - 2.0) < TOL

    # Verify construction point position
    assert abs(sk["construction_pt"][0] - 7.5) < TOL
    assert abs(sk["construction_pt"][1] - 7.5) < TOL


def test_square_with_construction_diagonals(sketch_log):
    """A square with 2 construction diagonals coincident with a center point."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Square with Construction Diagonals"
    initial:
      side_bottom:  [0.0, 0.0, 10.0, 0.0]
      side_right:   [10.0, 0.0, 10.0, 10.0]
      side_top:     [10.0, 10.0, 0.0, 10.0]
      side_left:    [0.0, 10.0, 0.0, 0.0]
      diag_br_tl:   [10.0, 0.0, 0.0, 10.0]
      diag_bl_tr:   [0.0, 0.0, 10.0, 10.0]
      center:       [5.0, 5.0]
    entities:
      - id: side_bottom
        kind: line
      - id: side_right
        kind: line
      - id: side_top
        kind: line
      - id: side_left
        kind: line
      - id: diag_br_tl
        kind: line
        construction: true
      - id: diag_bl_tr
        kind: line
        construction: true
      - id: center
        kind: point
    constraints:
      - id: c_bottom_horiz
        kind: horizontal
        target: {entity: side_bottom}
      - id: c_bottom_len
        kind: length
        target: {entity: side_bottom}
        value: 10.0
      - id: c_bottom_fix
        kind: fixed
        target: {entity: side_bottom, point: start}
        x: 0.0
        y: 0.0
      - id: c_right_vert
        kind: vertical
        target: {entity: side_right}
      - id: c_right_len
        kind: length
        target: {entity: side_right}
        value: 10.0
      - id: c_top_horiz
        kind: horizontal
        target: {entity: side_top}
      - id: c_top_len
        kind: length
        target: {entity: side_top}
        value: 10.0
      - id: c_left_vert
        kind: vertical
        target: {entity: side_left}
      - id: c_left_len
        kind: length
        target: {entity: side_left}
        value: 10.0
      - id: c_join_br
        kind: coincident
        a: {entity: side_bottom, point: end}
        b: {entity: side_right, point: start}
      - id: c_join_tr
        kind: coincident
        a: {entity: side_right, point: end}
        b: {entity: side_top, point: start}
      - id: c_join_tl
        kind: coincident
        a: {entity: side_top, point: end}
        b: {entity: side_left, point: start}
      - id: c_diag_br_tl_start
        kind: coincident
        a: {entity: diag_br_tl, point: start}
        b: {entity: side_right, point: start}
      - id: c_diag_br_tl_end
        kind: coincident
        a: {entity: diag_br_tl, point: end}
        b: {entity: side_left, point: start}
      - id: c_diag_bl_tr_start
        kind: coincident
        a: {entity: diag_bl_tr, point: start}
        b: {entity: side_bottom, point: start}
      - id: c_diag_bl_tr_end
        kind: coincident
        a: {entity: diag_bl_tr, point: end}
        b: {entity: side_top, point: start}
      - id: c_center_on_diag_br_tl
        kind: midpoint
        line: {entity: diag_br_tl}
        point: {entity: center}
      - id: c_center_on_diag_bl_tr
        kind: midpoint
        line: {entity: diag_bl_tr}
        point: {entity: center}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_square_with_construction_diagonals", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify square dimensions
    assert abs(length(sk["side_bottom"][0:2], sk["side_bottom"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_right"][0:2], sk["side_right"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_top"][0:2], sk["side_top"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_left"][0:2], sk["side_left"][2:4]) - 10.0) < TOL

    # Note: construction flag is not preserved in flat array format
    # assert sk["diag_br_tl"].get("construction")
    # assert sk["diag_bl_tr"].get("construction")

    # Verify center point is at (5, 5)
    assert abs(sk["center"][0] - 5.0) < TOL
    assert abs(sk["center"][1] - 5.0) < TOL

    # Verify diagonals connect opposite corners
    diag1_start = sk["diag_br_tl"][0:2]
    diag1_end = sk["diag_br_tl"][2:4]
    right_start = sk["side_right"][0:2]
    left_start = sk["side_left"][0:2]
    assert abs(diag1_start[0] - right_start[0]) < TOL
    assert abs(diag1_start[1] - right_start[1]) < TOL
    assert abs(diag1_end[0] - left_start[0]) < TOL
    assert abs(diag1_end[1] - left_start[1]) < TOL

    diag2_start = sk["diag_bl_tr"][0:2]
    diag2_end = sk["diag_bl_tr"][2:4]
    bottom_start = sk["side_bottom"][0:2]
    top_start = sk["side_top"][0:2]  # top-right corner
    assert abs(diag2_start[0] - bottom_start[0]) < TOL
    assert abs(diag2_start[1] - bottom_start[1]) < TOL
    assert abs(diag2_end[0] - top_start[0]) < TOL
    assert abs(diag2_end[1] - top_start[1]) < TOL

    # Verify center is at the intersection of both diagonals (midpoint of each)
    cx, cy = sk["center"][0], sk["center"][1]
    diag1_mid_x = (sk["diag_br_tl"][0:2][0] + sk["diag_br_tl"][2:4][0]) / 2
    diag1_mid_y = (sk["diag_br_tl"][0:2][1] + sk["diag_br_tl"][2:4][1]) / 2
    diag2_mid_x = (sk["diag_bl_tr"][0:2][0] + sk["diag_bl_tr"][2:4][0]) / 2
    diag2_mid_y = (sk["diag_bl_tr"][0:2][1] + sk["diag_bl_tr"][2:4][1]) / 2
    assert abs(cx - diag1_mid_x) < TOL
    assert abs(cy - diag1_mid_y) < TOL
    assert abs(cx - diag2_mid_x) < TOL
    assert abs(cy - diag2_mid_y) < TOL


def test_thales_circle_theorem(sketch_log):
    """Thales' theorem: angle inscribed in a semicircle is a right angle.

    If AC is a diameter of a circle and B is any point on the circle,
    then angle ABC is 90 degrees. This test uses an asymmetric configuration
    with the circle off-center and diameter at an angle.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Thales Circle Theorem (Asymmetric)"
    initial:
      circle:       [3.0, 2.0, 4.0]
      pt_a:         [0.5, 3.0]
      pt_b:         [4.5, 5.0]
      pt_c:         [5.5, 1.0]
      line_ab:      [0.5, 3.0, 4.5, 5.0]
      line_bc:      [4.5, 5.0, 5.5, 1.0]
      line_ac:      [0.5, 3.0, 5.5, 1.0]
    entities:
      - id: circle
        kind: circle
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: line_ab
        kind: line
      - id: line_bc
        kind: line
      - id: line_ac
        kind: line
    constraints:
      - id: c_circle_center
        kind: fixed
        target: {entity: circle}
        x: 3.0
        y: 2.0
      - id: c_circle_radius
        kind: radius
        target: {entity: circle}
        value: 4.0
      - id: c_pt_a_on_circle
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: circle}
        value: 4.0
      - id: c_pt_b_on_circle
        kind: point_distance
        a: {entity: pt_b}
        b: {entity: circle}
        value: 4.0
      - id: c_pt_c_on_circle
        kind: point_distance
        a: {entity: pt_c}
        b: {entity: circle}
        value: 4.0
      - id: c_ac_diameter
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_c}
        value: 8.0
      - id: c_line_ab_start
        kind: coincident
        a: {entity: line_ab, point: start}
        b: {entity: pt_a}
      - id: c_line_ab_end
        kind: coincident
        a: {entity: line_ab, point: end}
        b: {entity: pt_b}
      - id: c_line_bc_start
        kind: coincident
        a: {entity: line_bc, point: start}
        b: {entity: pt_b}
      - id: c_line_bc_end
        kind: coincident
        a: {entity: line_bc, point: end}
        b: {entity: pt_c}
      - id: c_line_ac_start
        kind: coincident
        a: {entity: line_ac, point: start}
        b: {entity: pt_a}
      - id: c_line_ac_end
        kind: coincident
        a: {entity: line_ac, point: end}
        b: {entity: pt_c}
      - id: c_right_angle_abc
        kind: angle
        a: {entity: line_ab}
        b: {entity: line_bc}
        value: 90.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_thales_circle_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify circle properties
    circle_center = sk["circle"][0:2]
    assert abs(circle_center[0] - 3.0) < TOL
    assert abs(circle_center[1] - 2.0) < TOL
    assert abs(sk["circle"][2] - 4.0) < TOL

    # Verify points on circle
    pt_a_coords = [sk["pt_a"][0], sk["pt_a"][1]]
    pt_b_coords = [sk["pt_b"][0], sk["pt_b"][1]]
    pt_c_coords = [sk["pt_c"][0], sk["pt_c"][1]]
    dist_a = length(pt_a_coords, circle_center)
    dist_b = length(pt_b_coords, circle_center)
    dist_c = length(pt_c_coords, circle_center)
    assert abs(dist_a - 4.0) < TOL
    assert abs(dist_b - 4.0) < TOL
    assert abs(dist_c - 4.0) < TOL

    # Verify AC is a diameter
    dist_ac = length(pt_a_coords, pt_c_coords)
    assert abs(dist_ac - 8.0) < TOL

    # Verify angle ABC is 90 degrees (perpendicular vectors have zero dot product)
    pt_a_x, pt_a_y = sk["pt_a"][0], sk["pt_a"][1]
    pt_b_x, pt_b_y = sk["pt_b"][0], sk["pt_b"][1]
    pt_c_x, pt_c_y = sk["pt_c"][0], sk["pt_c"][1]
    vec_ba_x = pt_a_x - pt_b_x
    vec_ba_y = pt_a_y - pt_b_y
    vec_bc_x = pt_c_x - pt_b_x
    vec_bc_y = pt_c_y - pt_b_y
    dot_product = vec_ba_x * vec_bc_x + vec_ba_y * vec_bc_y
    assert abs(dot_product) < TOL


def test_pythagoras_3_4_5(sketch_log):
    """Pythagorean theorem: a² + b² = c² for a 3-4-5 right triangle.

    Create a right triangle with legs of length 3 and 4,
    and verify that the hypotenuse has length 5.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Pythagorean 3-4-5 Triangle"
    initial:
      pt_a:    [0.0, 0.0]
      pt_b:    [3.0, 0.0]
      pt_c:    [3.0, 4.0]
      leg_ab:  [0.0, 0.0, 3.0, 0.0]
      leg_bc:  [3.0, 0.0, 3.0, 4.0]
      hyp_ca:  [3.0, 4.0, 0.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: leg_ab
        kind: line
      - id: leg_bc
        kind: line
      - id: hyp_ca
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_leg_ab_horizontal
        kind: horizontal
        target: {entity: leg_ab}
      - id: c_leg_ab_length
        kind: length
        target: {entity: leg_ab}
        value: 3.0
      - id: c_leg_bc_vertical
        kind: vertical
        target: {entity: leg_bc}
      - id: c_leg_bc_length
        kind: length
        target: {entity: leg_bc}
        value: 4.0
      - id: c_right_angle_abc
        kind: normal
        a: {entity: leg_ab}
        b: {entity: leg_bc}
      - id: c_leg_ab_start
        kind: coincident
        a: {entity: leg_ab, point: start}
        b: {entity: pt_a}
      - id: c_leg_ab_end
        kind: coincident
        a: {entity: leg_ab, point: end}
        b: {entity: pt_b}
      - id: c_leg_bc_start
        kind: coincident
        a: {entity: leg_bc, point: start}
        b: {entity: pt_b}
      - id: c_leg_bc_end
        kind: coincident
        a: {entity: leg_bc, point: end}
        b: {entity: pt_c}
      - id: c_hyp_ca_start
        kind: coincident
        a: {entity: hyp_ca, point: start}
        b: {entity: pt_c}
      - id: c_hyp_ca_end
        kind: coincident
        a: {entity: hyp_ca, point: end}
        b: {entity: pt_a}
      - id: c_hyp_ca_length
        kind: length
        target: {entity: hyp_ca}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_pythagoras_3_4_5", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify the right angle at A
    assert abs(sk["pt_a"][0] - 0.0) < TOL
    assert abs(sk["pt_a"][1] - 0.0) < TOL

    # Verify leg lengths
    leg_ab_len = length(
        [sk["leg_ab"][0:2][0], sk["leg_ab"][0:2][1]],
        [sk["leg_ab"][2:4][0], sk["leg_ab"][2:4][1]]
    )
    leg_bc_len = length(
        [sk["leg_bc"][0:2][0], sk["leg_bc"][0:2][1]],
        [sk["leg_bc"][2:4][0], sk["leg_bc"][2:4][1]]
    )
    assert abs(leg_ab_len - 3.0) < TOL
    assert abs(leg_bc_len - 4.0) < TOL

    # Verify hypotenuse length (should be 5 by Pythagorean theorem)
    hyp_len = length(
        [sk["hyp_ca"][0:2][0], sk["hyp_ca"][0:2][1]],
        [sk["hyp_ca"][2:4][0], sk["hyp_ca"][2:4][1]]
    )
    assert abs(hyp_len - 5.0) < TOL

    # Verify the theorem: a² + b² = c²
    a_squared = 3.0 ** 2
    b_squared = 4.0 ** 2
    c_squared = hyp_len ** 2
    assert abs(a_squared + b_squared - c_squared) < TOL * 10


def test_angle_sum_theorem(sketch_log):
    """Angle sum theorem: the sum of angles in a triangle equals 180 degrees.

    Create a triangle and verify that the interior angles sum to 180°.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle Sum Theorem Triangle"
    initial:
      pt_a:   [0.0, 0.0]
      pt_b:   [5.0, 0.0]
      pt_c:   [1.5, 2.0]
      side_ab: [0.0, 0.0, 5.0, 0.0]
      side_bc: [5.0, 0.0, 1.5, 2.0]
      side_ca: [1.5, 2.0, 0.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: side_ab
        kind: line
      - id: side_bc
        kind: line
      - id: side_ca
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_side_ab_horizontal
        kind: horizontal
        target: {entity: side_ab}
      - id: c_side_ab_length
        kind: length
        target: {entity: side_ab}
        value: 5.0
      - id: c_side_ab_start
        kind: coincident
        a: {entity: side_ab, point: start}
        b: {entity: pt_a}
      - id: c_side_ab_end
        kind: coincident
        a: {entity: side_ab, point: end}
        b: {entity: pt_b}
      - id: c_side_bc_start
        kind: coincident
        a: {entity: side_bc, point: start}
        b: {entity: pt_b}
      - id: c_side_bc_end
        kind: coincident
        a: {entity: side_bc, point: end}
        b: {entity: pt_c}
      - id: c_side_ca_start
        kind: coincident
        a: {entity: side_ca, point: start}
        b: {entity: pt_c}
      - id: c_side_ca_end
        kind: coincident
        a: {entity: side_ca, point: end}
        b: {entity: pt_a}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_sum_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify the triangle is properly solved
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    angle_a = angle_at_vertex(pt_a, pt_b, pt_c)
    angle_b = angle_at_vertex(pt_b, pt_a, pt_c)
    angle_c = angle_at_vertex(pt_c, pt_a, pt_b)

    # Verify the angle sum is 180 degrees (angle sum theorem)
    angle_sum = angle_a + angle_b + angle_c
    assert abs(angle_sum - 180.0) < ATOL * 10, f"Angle sum {angle_sum} != 180°"


def test_vertical_angles_theorem(sketch_log):
    """Vertical angles theorem: opposite angles formed by intersecting lines are equal.

    When two lines intersect, the opposite (vertical) angles are congruent.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Vertical Angles Theorem"
    initial:
      pt_center: [0.0, 0.0]
      pt_a:      [-2.0, 1.0]
      pt_b:      [2.0, -1.0]
      pt_c:      [1.0, 2.0]
      pt_d:      [-1.0, -2.0]
      line_ab:   [-2.0, 1.0, 2.0, -1.0]
      line_cd:   [1.0, 2.0, -1.0, -2.0]
    entities:
      - id: pt_center
        kind: point
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: line_ab
        kind: line
      - id: line_cd
        kind: line
    constraints:
      - id: c_pt_center_fixed
        kind: fixed
        target: {entity: pt_center}
        x: 0.0
        y: 0.0
      - id: c_line_ab_through_center
        kind: midpoint
        line: {entity: line_ab}
        point: {entity: pt_center}
      - id: c_line_cd_through_center
        kind: midpoint
        line: {entity: line_cd}
        point: {entity: pt_center}
      - id: c_line_ab_length
        kind: length
        target: {entity: line_ab}
        value: 4.472135954999579
      - id: c_line_cd_length
        kind: length
        target: {entity: line_cd}
        value: 4.472135954999579
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_vertical_angles_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract intersection point and endpoints
    pt_center = (sk["pt_center"][0], sk["pt_center"][1])
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])
    pt_d = (sk["pt_d"][0], sk["pt_d"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Compute the four angles at the intersection
    angle_ac = angle_at_vertex(pt_center, pt_a, pt_c)  # angle between A and C rays
    angle_cb = angle_at_vertex(pt_center, pt_c, pt_b)  # angle between C and B rays
    angle_bd = angle_at_vertex(pt_center, pt_b, pt_d)  # angle between B and D rays
    angle_da = angle_at_vertex(pt_center, pt_d, pt_a)  # angle between D and A rays

    # Verify vertical angles are equal
    # Vertical angles: (angle_ac == angle_bd) and (angle_cb == angle_da)
    assert abs(angle_ac - angle_bd) < ATOL, f"Vertical angles {angle_ac}° and {angle_bd}° should be equal"
    assert abs(angle_cb - angle_da) < ATOL, f"Vertical angles {angle_cb}° and {angle_da}° should be equal"


def test_alternate_interior_angles_theorem(sketch_log):
    """Alternate interior angles theorem: when a transversal crosses two parallel lines,
    the alternate interior angles are congruent.

    If lines AB and CD are parallel, and transversal EF crosses them,
    then angle at intersection with AB equals angle at intersection with CD.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Alternate Interior Angles Theorem"
    initial:
      pt_a:      [0.0, 0.0]
      pt_b:      [5.0, 0.0]
      pt_c:      [0.0, 2.0]
      pt_d:      [5.0, 2.0]
      pt_e:      [-1.0, -1.0]
      pt_f:      [6.0, 3.0]
      line_ab:   [0.0, 0.0, 5.0, 0.0]
      line_cd:   [0.0, 2.0, 5.0, 2.0]
      transversal: [-1.0, -1.0, 6.0, 3.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: pt_e
        kind: point
      - id: pt_f
        kind: point
      - id: line_ab
        kind: line
      - id: line_cd
        kind: line
      - id: transversal
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_line_ab_horizontal
        kind: horizontal
        target: {entity: line_ab}
      - id: c_line_ab_length
        kind: length
        target: {entity: line_ab}
        value: 5.0
      - id: c_line_ab_start
        kind: coincident
        a: {entity: line_ab, point: start}
        b: {entity: pt_a}
      - id: c_line_ab_end
        kind: coincident
        a: {entity: line_ab, point: end}
        b: {entity: pt_b}
      - id: c_line_cd_parallel_to_ab
        kind: parallel
        a: {entity: line_ab}
        b: {entity: line_cd}
      - id: c_line_cd_length
        kind: length
        target: {entity: line_cd}
        value: 5.0
      - id: c_line_cd_start
        kind: coincident
        a: {entity: line_cd, point: start}
        b: {entity: pt_c}
      - id: c_line_cd_end
        kind: coincident
        a: {entity: line_cd, point: end}
        b: {entity: pt_d}
      - id: c_separation
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_c}
        value: 2.0
      - id: c_transversal_start
        kind: coincident
        a: {entity: transversal, point: start}
        b: {entity: pt_e}
      - id: c_transversal_end
        kind: coincident
        a: {entity: transversal, point: end}
        b: {entity: pt_f}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_alternate_interior_angles_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract points for angle calculation
    # Find intersection of transversal with line_ab
    transv_start = (sk["transversal"][0:2][0], sk["transversal"][0:2][1])
    transv_end = (sk["transversal"][2:4][0], sk["transversal"][2:4][1])
    line_ab_start = (sk["line_ab"][0:2][0], sk["line_ab"][0:2][1])
    line_ab_end = (sk["line_ab"][2:4][0], sk["line_ab"][2:4][1])
    line_cd_start = (sk["line_cd"][0:2][0], sk["line_cd"][0:2][1])
    line_cd_end = (sk["line_cd"][2:4][0], sk["line_cd"][2:4][1])

    # Helper to compute angle between two lines
    def angle_between_lines(line1_start, line1_end, line2_start, line2_end):
        """Compute angle between two lines at their intersection point."""
        dir1_x = line1_end[0] - line1_start[0]
        dir1_y = line1_end[1] - line1_start[1]
        dir2_x = line2_end[0] - line2_start[0]
        dir2_y = line2_end[1] - line2_start[1]
        dot = dir1_x * dir2_x + dir1_y * dir2_y
        len1 = math.sqrt(dir1_x**2 + dir1_y**2)
        len2 = math.sqrt(dir2_x**2 + dir2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Angle between transversal and line_ab
    angle_at_ab = angle_between_lines(transv_start, transv_end, line_ab_start, line_ab_end)
    # Angle between transversal and line_cd
    angle_at_cd = angle_between_lines(transv_start, transv_end, line_cd_start, line_cd_end)

    # Verify that the lines are parallel (lines AB and CD should have same angle with transversal)
    assert abs(angle_at_ab - angle_at_cd) < ATOL, f"Angles should be equal for parallel lines: {angle_at_ab}° vs {angle_at_cd}°"


def test_exterior_angle_theorem(sketch_log):
    """Exterior angle theorem: an exterior angle of a triangle equals the sum of
    the two non-adjacent interior angles.

    If we extend side AB to point D beyond B, the exterior angle DBC equals
    the sum of the two remote interior angles BAC and BCA.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Exterior Angle Theorem"
    initial:
      pt_a:    [0.0, 0.0]
      pt_b:    [4.0, 0.0]
      pt_c:    [1.0, 2.0]
      pt_d:    [6.0, 0.0]
      side_ab: [0.0, 0.0, 4.0, 0.0]
      side_bc: [4.0, 0.0, 1.0, 2.0]
      side_ca: [1.0, 2.0, 0.0, 0.0]
      ext_bd:  [4.0, 0.0, 6.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: side_ab
        kind: line
      - id: side_bc
        kind: line
      - id: side_ca
        kind: line
      - id: ext_bd
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_side_ab_horizontal
        kind: horizontal
        target: {entity: side_ab}
      - id: c_side_ab_length
        kind: length
        target: {entity: side_ab}
        value: 4.0
      - id: c_side_ab_start
        kind: coincident
        a: {entity: side_ab, point: start}
        b: {entity: pt_a}
      - id: c_side_ab_end
        kind: coincident
        a: {entity: side_ab, point: end}
        b: {entity: pt_b}
      - id: c_side_bc_start
        kind: coincident
        a: {entity: side_bc, point: start}
        b: {entity: pt_b}
      - id: c_side_bc_end
        kind: coincident
        a: {entity: side_bc, point: end}
        b: {entity: pt_c}
      - id: c_side_ca_start
        kind: coincident
        a: {entity: side_ca, point: start}
        b: {entity: pt_c}
      - id: c_side_ca_end
        kind: coincident
        a: {entity: side_ca, point: end}
        b: {entity: pt_a}
      - id: c_ext_bd_horizontal
        kind: horizontal
        target: {entity: ext_bd}
      - id: c_ext_bd_length
        kind: length
        target: {entity: ext_bd}
        value: 2.0
      - id: c_ext_bd_start
        kind: coincident
        a: {entity: ext_bd, point: start}
        b: {entity: pt_b}
      - id: c_ext_bd_end
        kind: coincident
        a: {entity: ext_bd, point: end}
        b: {entity: pt_d}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_exterior_angle_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract points
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])
    pt_d = (sk["pt_d"][0], sk["pt_d"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Interior angles of the triangle
    angle_a = angle_at_vertex(pt_a, pt_b, pt_c)  # angle BAC
    angle_c = angle_at_vertex(pt_c, pt_a, pt_b)  # angle BCA

    # Exterior angle at B (angle DBC)
    # This is the angle between ray BC and ray BD
    angle_exterior = angle_at_vertex(pt_b, pt_d, pt_c)

    # Verify exterior angle theorem: exterior angle = sum of two remote interior angles
    angle_sum = angle_a + angle_c
    assert abs(angle_exterior - angle_sum) < ATOL * 2, \
        f"Exterior angle {angle_exterior}° should equal sum of remote interior angles {angle_sum}°"


def test_hourglass_shape(sketch_log):
    """Test hourglass shape with 4 lines, 2 crossing in the middle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Hourglass"
    initial:
      tl: [0.0, 2.0]
      tr: [2.0, 2.0]
      bl: [0.0, 0.0]
      br: [2.0, 0.0]
    entities:
      - id: tl
        kind: point
      - id: tr
        kind: point
      - id: bl
        kind: point
      - id: br
        kind: point
      - id: top_line
        kind: line
      - id: bottom_line
        kind: line
      - id: diag_left
        kind: line
      - id: diag_right
        kind: line
    constraints:
      # Top line: tl to tr
      - id: c_top_start
        kind: coincident
        a: {entity: top_line, point: start}
        b: {entity: tl}
      - id: c_top_end
        kind: coincident
        a: {entity: top_line, point: end}
        b: {entity: tr}
      # Bottom line: bl to br
      - id: c_bottom_start
        kind: coincident
        a: {entity: bottom_line, point: start}
        b: {entity: bl}
      - id: c_bottom_end
        kind: coincident
        a: {entity: bottom_line, point: end}
        b: {entity: br}
      # Diagonal left: tl to br
      - id: c_diag_left_start
        kind: coincident
        a: {entity: diag_left, point: start}
        b: {entity: tl}
      - id: c_diag_left_end
        kind: coincident
        a: {entity: diag_left, point: end}
        b: {entity: br}
      # Diagonal right: tr to bl
      - id: c_diag_right_start
        kind: coincident
        a: {entity: diag_right, point: start}
        b: {entity: tr}
      - id: c_diag_right_end
        kind: coincident
        a: {entity: diag_right, point: end}
        b: {entity: bl}
      # Fix top-left corner
      - id: c_tl_fixed
        kind: fixed
        target: {entity: tl}
        x: 0.0
        y: 2.0
      # Top line horizontal
      - id: c_top_horiz
        kind: horizontal
        target: {entity: top_line}
      # Bottom line horizontal
      - id: c_bottom_horiz
        kind: horizontal
        target: {entity: bottom_line}
      # Top line length
      - id: c_top_length
        kind: length
        target: {entity: top_line}
        value: 2.0
      # Bottom line length
      - id: c_bottom_length
        kind: length
        target: {entity: bottom_line}
        value: 2.0
      # Diagonal length (≈ 2√2)
      - id: c_diag_length
        kind: length
        target: {entity: diag_left}
        value: 2.828
      # Rotation fix
      - id: c_rot_fix
        kind: vertical
        a: {entity: tl}
        b: {entity: bl}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_hourglass_shape", yaml_str, result)
    # Verify all line entities are present
    assert "diag_left" in result["geometry"]
    assert "diag_right" in result["geometry"]
    assert "top_line" in result["geometry"]
    assert "bottom_line" in result["geometry"]

    # Verify the sketch is fully constrained
    assert result["status"] == "fully_constrained"


def test_venn_diagram_two_circles(sketch_log):
    """Test Venn diagram with two overlapping circles."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Venn Diagram"
    initial:
      c1: [0.5, 0.5]
      c2: [1.5, 0.5]
    entities:
      - id: c1
        kind: point
      - id: c2
        kind: point
      - id: circle1
        kind: circle
      - id: circle2
        kind: circle
    constraints:
      # Circle 1 center fixed at origin (0.5, 0.5)
      - id: c_c1_fixed
        kind: fixed
        target: {entity: c1}
        x: 0.5
        y: 0.5
      # Circle 1 center coincident with point
      - id: c_circle1_center
        kind: coincident
        a: {entity: circle1, point: center}
        b: {entity: c1}
      # Circle 1 radius
      - id: c_circle1_radius
        kind: radius
        target: {entity: circle1}
        value: 0.6
      # Circle 2 center coincident with point
      - id: c_circle2_center
        kind: coincident
        a: {entity: circle2, point: center}
        b: {entity: c2}
      # Circle 2 radius (same as circle 1 for symmetric Venn diagram)
      - id: c_circle2_radius
        kind: radius
        target: {entity: circle2}
        value: 0.6
      # Distance constraint between circle centers
      - id: c_center_distance
        kind: point_distance
        a: {entity: c1}
        b: {entity: c2}
        value: 0.8
      # Orientation fix
      - id: c_orientation
        kind: horizontal
        a: {entity: c1}
        b: {entity: c2}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_venn_diagram_two_circles", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    # Verify both circles are present
    assert "circle1" in result["geometry"]
    assert "circle2" in result["geometry"]

    # Verify circle 1
    circle1 = geom["circle1"]
    assert "center" in circle1
    assert "radius" in circle1
    assert abs(circle1["radius"] - 0.6) < 0.01

    # Verify circle 2
    circle2 = geom["circle2"]
    assert "center" in circle2
    assert "radius" in circle2
    assert abs(circle2["radius"] - 0.6) < 0.01

    # Verify the circles overlap (distance between centers < sum of radii)
    c1_center = circle1["center"]
    c2_center = circle2["center"]
    dist = ((c1_center[0] - c2_center[0])**2 + (c1_center[1] - c2_center[1])**2)**0.5
    sum_radii = circle1["radius"] + circle2["radius"]
    assert dist < sum_radii, "Circles should overlap for Venn diagram"

    # Verify the sketch is fully constrained
    assert result["status"] == "fully_constrained"


import textwrap


def test_circle_arc_horizontal_constraint(sketch_log):
    """Circle and arc fully constrained via horizontal, two verticals, and two radius constraints."""
    yaml_str = textwrap.dedent("""
        version: 1
        kind: part

        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_front"
            entities: [ { id: circle1, kind: circle }, { id: arc1, kind: arc } ]
            constraints:
              - id: c_horizontal_1
                kind: horizontal
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: end }
              - id: c_radius_circle
                kind: radius
                target: { entity: circle1 }
                value: 0.5
              - id: c_radius_arc
                kind: radius
                target: { entity: arc1 }
                value: 0.8
              - id: c_vertical_1
                kind: vertical
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: start }
              - id: c_vertical_2
                kind: vertical
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: end }
              - id: c_fix_circle
                kind: fixed
                target: { entity: circle1, point: center }
                x: 0.0
                y: 0.0
              - id: c_fix_arc
                kind: fixed
                target: { entity: arc1, point: center }
                x: 0.0
                y: 0.8
            initial:
              circle1:
                - -0.010286
                - 0.63888
                - 0.451166
              arc1:
                - -0.182578
                - 0.13224
                - 1.101525
                - 49.373795
                - 147.230997
    """).strip()

    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_circle_arc_horizontal_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    circle1 = geom["circle1"]
    arc1 = geom["arc1"]

    # Radius constraints
    assert abs(circle1["radius"] - 0.5) < TOL, f"circle radius expected 0.5, got {circle1['radius']}"
    assert abs(arc1["radius"] - 0.8) < TOL, f"arc radius expected 0.8, got {arc1['radius']}"

    # Horizontal: circle center y == arc end y
    assert abs(circle1["center"][1] - arc1["end"][1]) < TOL, \
        f"Horizontal failed: circle y={circle1['center'][1]}, arc end y={arc1['end'][1]}"

    # Vertical 1: circle center x == arc start x
    assert abs(circle1["center"][0] - arc1["start"][0]) < TOL, \
        f"Vertical 1 failed: circle x={circle1['center'][0]}, arc start x={arc1['start'][0]}"

    # Vertical 2: circle center x == arc end x
    assert abs(circle1["center"][0] - arc1["end"][0]) < TOL, \
        f"Vertical 2 failed: circle x={circle1['center'][0]}, arc end x={arc1['end'][0]}"

    assert result["status"] == "fully_constrained"


def test_empty_sketch_superfluous_constraint(sketch_log):
    """An empty sketch with a constraint referencing unknown entities is silently ignored."""
    yaml_str = """version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities: []
    constraints:
      - id: c_bogus
        kind: horizontal
        a: { entity: nonexistent_a, point: center }
        b: { entity: nonexistent_b, point: end }
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_empty_sketch_superfluous_constraint", yaml_str, result)
    # Empty sketch with no entities should still solve successfully
    assert result["status"] == "fully_constrained"
    assert result["geometry"] == {}


def test_fixed_line_endpoint(sketch_log):
    """A line with a fixed endpoint constraint should remain at that position."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [-0.838727, 0.849922, -0.071016, 1.154386]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_1
        kind: fixed
        target: {entity: line1, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_line_endpoint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line = geom["line1"]
    fixed_end = [-0.071016, 1.154386]

    assert abs(line["end"][0] - fixed_end[0]) < TOL, f"end x should be fixed at {fixed_end[0]}, got {line['end'][0]}"
    assert abs(line["end"][1] - fixed_end[1]) < TOL, f"end y should be fixed at {fixed_end[1]}, got {line['end'][1]}"
    assert result["status"] == "underconstrained"


def test_fixed_entire_line(sketch_log):
    """A line with a fixed constraint on the entire entity should remain fully fixed."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [-0.838727, 0.849922, -0.071016, 1.154386]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_1
        kind: fixed
        target: {entity: line1}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_entire_line", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line = geom["line1"]
    fixed_start = [-0.838727, 0.849922]
    fixed_end = [-0.071016, 1.154386]

    assert abs(line.start[0] - fixed_start[0]) < TOL, f"start x should be fixed at {fixed_start[0]}, got {line.start[0]}"
    assert abs(line.start[1] - fixed_start[1]) < TOL, f"start y should be fixed at {fixed_start[1]}, got {line.start[1]}"
    assert abs(line.end[0] - fixed_end[0]) < TOL, f"end x should be fixed at {fixed_end[0]}, got {line.end[0]}"
    assert abs(line.end[1] - fixed_end[1]) < TOL, f"end y should be fixed at {fixed_end[1]}, got {line.end[1]}"
    assert result["status"] == "fully_constrained"


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


# ---------------------------------------------------------------------------
# Tests for previously untested / under-tested areas
# ---------------------------------------------------------------------------


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
    dropped — they must NOT cause a 'string indices must be integers' exception.

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


# ---------------------------------------------------------------------------
# Angle constraint direction tests
# ---------------------------------------------------------------------------
# The solver constrains cos(angle(da, db)) = cos(value) where
#   da = ea.end - ea.start  (forward direction of line A)
#   db = eb.end - eb.start  (forward direction of line B)
# Two lines can share a vertex at any of 4 combinations of endpoints.
# The render data must encode both line directions so the arc is drawn
# in the sector that actually equals `value`, regardless of line orientation.

def _angle_between_directions(a_s, a_e, b_s, b_e):
    """Angle between direction vectors da=(a_e-a_s) and db=(b_e-b_s), in degrees."""
    da = (a_e[0] - a_s[0], a_e[1] - a_s[1])
    db = (b_e[0] - b_s[0], b_e[1] - b_s[1])
    la = math.hypot(*da)
    lb = math.hypot(*db)
    cos_val = (da[0]*db[0] + da[1]*db[1]) / (la * lb)
    return math.degrees(math.acos(max(-1.0, min(1.0, cos_val))))


def _check_angle_render(render, expected_deg, tol=1e-2):
    """
    Verify that the dim_angle render data encodes both line directions correctly.

    After the fix, the render data stores:
      p1, p2  -> line A:  direction da = p2 - p1
      p3, p4  -> line B:  direction db = p4 - p3
    The angle between da and db must equal expected_deg.
    """
    assert render["kind"] == "dim_angle", f"Expected dim_angle, got {render['kind']}"
    p1, p2 = render["p1"], render["p2"]
    p3, p4 = render["p3"], render["p4"]
    actual = _angle_between_directions(p1, p2, p3, p4)
    assert abs(actual - expected_deg) < tol, (
        f"Render arc angle {actual:.3f}° != expected {expected_deg}°. "
        f"p1={p1} p2={p2} p3={p3} p4={p4}"
    )


def test_angle_direction_ea_end_eb_start(sketch_log):
    """45° constraint: vertex at ea.end = eb.start (standard L-shape orientation).

    Line A goes right (→), Line B goes up-right from the end of A.
    Both direction vectors start at different ends, vertex = ea.end = eb.start.
    The solver must enforce angle(da, db) = 45° and the render data must
    store both full line directions so p2-p1 = da and p4-p3 = db.
    """
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle dir: ea.end = eb.start"
    initial:
      line_a: [0.0, 0.0, 3.0, 0.0]
      line_b: [3.0, 0.0, 5.0, 2.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_origin
        kind: fixed
        target: {entity: line_a, point: start}
        x: 0.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_coin
        kind: coincident
        a: {entity: line_a, point: end}
        b: {entity: line_b, point: start}
      - id: c_angle
        kind: angle
        a: {entity: line_a}
        b: {entity: line_b}
        value: 45.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_direction_ea_end_eb_start", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    a_s, a_e = geom["line_a"].start, geom["line_a"].end
    b_s, b_e = geom["line_b"].start, geom["line_b"].end

    # Solver must produce angle(da, db) = 45 degrees
    actual_angle = _angle_between_directions(a_s, a_e, b_s, b_e)
    assert abs(actual_angle - 45.0) < TOL, f"Solver angle {actual_angle:.4f}° != 45°"

    # Shared vertex must be at ea.end = eb.start
    assert abs(a_e[0] - b_s[0]) < TOL and abs(a_e[1] - b_s[1]) < TOL, "ea.end != eb.start"

    # Render data must encode both direction vectors
    render = result["constraints"]["c_angle"]["render"]
    _check_angle_render(render, 45.0)


def test_angle_direction_ea_end_eb_end(sketch_log):
    """45° constraint: vertex at ea.end = eb.end (line B is reversed).

    Line A goes right (→), Line B's END is at the vertex (line B goes toward vertex).
    da = (→), db points away from vertex in the direction of line B.
    The solver must still enforce angle(da, db) = 45° and the render data
    must correctly encode both directions.
    """
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle dir: ea.end = eb.end"
    initial:
      line_a: [0.0, 0.0, 3.0, 0.0]
      line_b: [5.0, 2.0, 3.0, 0.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_origin
        kind: fixed
        target: {entity: line_a, point: start}
        x: 0.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_coin
        kind: coincident
        a: {entity: line_a, point: end}
        b: {entity: line_b, point: end}
      - id: c_angle
        kind: angle
        a: {entity: line_a}
        b: {entity: line_b}
        value: 45.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_direction_ea_end_eb_end", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    a_s, a_e = geom["line_a"].start, geom["line_a"].end
    b_s, b_e = geom["line_b"].start, geom["line_b"].end

    # Solver must produce angle(da, db) = 45 degrees
    actual_angle = _angle_between_directions(a_s, a_e, b_s, b_e)
    assert abs(actual_angle - 45.0) < TOL, f"Solver angle {actual_angle:.4f}° != 45°"

    # Shared vertex must be at ea.end = eb.end
    assert abs(a_e[0] - b_e[0]) < TOL and abs(a_e[1] - b_e[1]) < TOL, "ea.end != eb.end"

    # Render data must encode both direction vectors so arc shows 45°
    render = result["constraints"]["c_angle"]["render"]
    _check_angle_render(render, 45.0)


def test_angle_direction_ea_start_eb_start(sketch_log):
    """45° constraint: vertex at ea.start = eb.start (line A is reversed).

    The START of both lines is the vertex. da points away from vertex (forward along A),
    db also points away from vertex (forward along B).
    """
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle dir: ea.start = eb.start"
    initial:
      line_a: [3.0, 0.0, 0.0, 0.0]
      line_b: [3.0, 0.0, 5.0, 2.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_vertex
        kind: fixed
        target: {entity: line_a, point: start}
        x: 3.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_coin
        kind: coincident
        a: {entity: line_a, point: start}
        b: {entity: line_b, point: start}
      - id: c_angle
        kind: angle
        a: {entity: line_a}
        b: {entity: line_b}
        value: 45.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_direction_ea_start_eb_start", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    a_s, a_e = geom["line_a"].start, geom["line_a"].end
    b_s, b_e = geom["line_b"].start, geom["line_b"].end

    actual_angle = _angle_between_directions(a_s, a_e, b_s, b_e)
    assert abs(actual_angle - 45.0) < TOL, f"Solver angle {actual_angle:.4f}° != 45°"

    assert abs(a_s[0] - b_s[0]) < TOL and abs(a_s[1] - b_s[1]) < TOL, "ea.start != eb.start"

    render = result["constraints"]["c_angle"]["render"]
    _check_angle_render(render, 45.0)


def test_angle_direction_ea_start_eb_end(sketch_log):
    """45° constraint: vertex at ea.start = eb.end (both lines reversed).

    Line A goes leftward (ea.start is the shared vertex, ea.end is on the right).
    Line B ends at the vertex (eb.end = ea.start).
    da = (←), db = (direction of B away from its start, toward vertex).
    """
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle dir: ea.start = eb.end"
    initial:
      line_a: [3.0, 0.0, 0.0, 0.0]
      line_b: [5.0, 2.0, 3.0, 0.0]
    entities:
      - id: line_a
        kind: line
      - id: line_b
        kind: line
    constraints:
      - id: c_fix_vertex
        kind: fixed
        target: {entity: line_a, point: start}
        x: 3.0
        y: 0.0
      - id: c_horiz
        kind: horizontal
        target: {entity: line_a}
      - id: c_coin
        kind: coincident
        a: {entity: line_a, point: start}
        b: {entity: line_b, point: end}
      - id: c_angle
        kind: angle
        a: {entity: line_a}
        b: {entity: line_b}
        value: 45.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_direction_ea_start_eb_end", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    a_s, a_e = geom["line_a"].start, geom["line_a"].end
    b_s, b_e = geom["line_b"].start, geom["line_b"].end

    actual_angle = _angle_between_directions(a_s, a_e, b_s, b_e)
    assert abs(actual_angle - 45.0) < TOL, f"Solver angle {actual_angle:.4f}° != 45°"

    assert abs(a_s[0] - b_e[0]) < TOL and abs(a_s[1] - b_e[1]) < TOL, "ea.start != eb.end"

    render = result["constraints"]["c_angle"]["render"]
    _check_angle_render(render, 45.0)


def test_disjoint_line_and_arc_no_boundary(sketch_log):
    """A line and arc that do not touch should produce no boundary surfaces."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      cYiJ_Vy34wyjaKwY:
        - -0.026051
        - -0.121987
        - 0.156042
        - -12.755509
        - -170.279105
      upwIgUnx-_ijZoDG:
        - -0.252489
        - -0.058073
        - 0.270697
        - -0.110216
    entities:
      - id: upwIgUnx-_ijZoDG
        kind: line
      - id: cYiJ_Vy34wyjaKwY
        kind: arc
    constraints: []
    label: thelabel
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_disjoint_line_and_arc_no_boundary", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    surfaces = result["topology"]["surfaces"]
    assert surfaces == [], f"Expected no surfaces, got {surfaces}"


def test_disjoint_line_and_arc_no_boundary_2(sketch_log):
    """A second disjoint line and arc configuration should also produce no boundary surfaces."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      cYiJ_Vy34wyjaKwY:
        - -0.026051
        - -0.121987
        - 0.156042
        - -12.755509
        - -170.279105
      upwIgUnx-_ijZoDG:
        - -0.247661
        - 0.038927
        - 0.171072
        - -0.261593
    entities:
      - id: upwIgUnx-_ijZoDG
        kind: line
      - id: cYiJ_Vy34wyjaKwY
        kind: arc
    constraints: []
    label: thelabel
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_disjoint_line_and_arc_no_boundary_2", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    surfaces = result["topology"]["surfaces"]
    assert surfaces == [], f"Expected no surfaces, got {surfaces}"


def test_intersecting_line_and_arc_creates_boundary(sketch_log):
    """A line and arc that intersect should produce at least one boundary surface."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      cYiJ_Vy34wyjaKwY:
        - -0.026051
        - -0.121987
        - 0.156042
        - -12.755509
        - -170.279105
      upwIgUnx-_ijZoDG:
        - -0.225752
        - -0.167627
        - 0.19797
        - -0.20278
    entities:
      - id: upwIgUnx-_ijZoDG
        kind: line
      - id: cYiJ_Vy34wyjaKwY
        kind: arc
    constraints: []
    label: thelabel
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_intersecting_line_and_arc_creates_boundary", yaml_str, result)
    assert result.get("status") != "exception", result.get("exception")
    surfaces = result["topology"]["surfaces"]
    assert len(surfaces) > 0, "Expected at least one boundary surface from intersecting line and arc"
