import math
import yaml as yaml_module
import pytest
from pytest import approx
from oversolved.kernel.solver import solve
from solver_helpers import TOL, length, angle_between, to_geom


def test_missing_plane_raises_error():
    """A sketch without a plane field now errors with a clear message (no silent default)."""
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
    assert result.get("status") == "exception"
    assert "plane" in result.get("exception", "").lower()


def test_unknown_plane_defaults_gracefully():
    """A sketch referencing a non-existent plane defaults to the front plane."""
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
    assert result.get("status") != "exception", result.get("exception")
    assert "plane_transform" in result


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


def test_concentric_circles_two_surfaces():
    """Two concentric circles produce two boundary surfaces: inner filled circle and outer annulus."""
    import textwrap
    yaml_str = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_front"
            initial:
              inner_circle: [0.0, 0.0, 2.0]
              outer_circle: [0.0, 0.0, 5.0]
            entities:
              - id: inner_circle
                kind: circle
              - id: outer_circle
                kind: circle
            constraints:
              - id: c_inner_radius
                kind: radius
                target: {entity: inner_circle}
                value: 2
              - id: c_outer_radius
                kind: radius
                target: {entity: outer_circle}
                value: 5
            label: "Concentric circles"
    """)
    result = solve(yaml_str)["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")

    surfaces = result["topology"]["surfaces"]
    assert len(surfaces) == 2, f"Expected 2 surfaces, got {len(surfaces)}"

    radii_in_surfaces = []
    for surf in surfaces:
        bounds = surf.get("boundary", [])
        radii = sorted(set(round(b.get("radius", 0), 1) for b in bounds if b.get("radius")))
        radii_in_surfaces.append(radii)

    inner_radii = next((r for r in radii_in_surfaces if 2.0 in r and 5.0 not in r), None)
    outer_radii = next((r for r in radii_in_surfaces if 2.0 in r and 5.0 in r), None)

    assert inner_radii is not None, (
        f"Inner surface (radius 2 only) not found. Got: {radii_in_surfaces}"
    )
    assert outer_radii is not None, (
        f"Outer annulus surface (radii 2+5) not found. Got: {radii_in_surfaces}"
    )


def test_repo_structure_cache_hit():
    """Solving the same sketch twice uses the cached repo structure."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "CacheLine"
    initial:
      L1: [0, 0, 10, 0]
    entities:
      - id: L1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: L1}
"""
    result1 = solve(yaml_str)["result"]["sketch_1"]
    assert result1.get("status") != "exception", result1.get("exception")

    # Same sketch with different initial parameters (cache should hit)
    yaml_str2 = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "CacheLine"
    initial:
      L1: [1, 2, 5, 2]
    entities:
      - id: L1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: L1}
"""
    result2 = solve(yaml_str2)["result"]["sketch_1"]
    assert result2.get("status") != "exception", result2.get("exception")


def test_repo_structure_cache_miss_on_entity_change():
    """Adding an entity changes the cache key, forcing a full rebuild."""
    yaml_str1 = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: L1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: L1}
"""
    result1 = solve(yaml_str1)["result"]["sketch_1"]
    assert result1.get("status") != "exception"

    # Two lines (different entity structure)
    yaml_str2 = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: L1
        kind: line
      - id: L2
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: L1}
      - id: c2
        kind: horizontal
        target: {entity: L2}
"""
    result2 = solve(yaml_str2)["result"]["sketch_1"]
    assert result2.get("status") != "exception"


def test_repo_structure_cache_capped_to_one_entry():
    """_last_repo_structure holds at most one entry regardless of how many repos are built."""
    import oversolved.kernel.solver as _solver_mod

    def _entities(prefix: str) -> dict:
        return {f"{prefix}_l1": {"kind": "line"}}

    for i in range(3):
        _solver_mod._get_or_build_repo(f"sk_cap_{i}", _entities(f"cap{i}"))

    entry = _solver_mod._last_repo_structure
    assert entry is not None
    # The variable is a single tuple (key, repo), not a dict with multiple entries.
    assert isinstance(entry, tuple)
    assert len(entry) == 2


@pytest.mark.parametrize("plane_name", ["Top", "Front", "Right"])
def test_resolve_sketch_plane_fallback(plane_name):
    """Built-in plane names resolve to standard planes when resolve_ref fails."""
    from oversolved.kernel.solver import _resolve_sketch_plane

    def resolve_ref(_query):
        return None

    result = _resolve_sketch_plane(plane_name, resolve_ref, None)
    assert result is not None
    assert "origin" in result
    assert "x_axis" in result
    assert "y_axis" in result
    assert "normal" in result
