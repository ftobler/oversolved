import math
import textwrap
import yaml as yaml_module
from pytest import approx
from oversolved.solver import solve
from solver_helpers import TOL, to_geom, minimal_sketch_yaml


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


# ── 2f: solver surface query present ──────────────────────────────────────────

def test_solver_surface_query_present():
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Triangle"
    initial:
      a: [0.0, 0.0, 2.0, 0.0]
      b: [2.0, 0.0, 1.0, 2.0]
      c: [1.0, 2.0, 0.0, 0.0]
    entities:
      - id: a
        kind: line
      - id: b
        kind: line
      - id: c
        kind: line
    constraints:
      - id: c_ab
        kind: coincident
        a: {entity: a, point: end}
        b: {entity: b, point: start}
      - id: c_bc
        kind: coincident
        a: {entity: b, point: end}
        b: {entity: c, point: start}
      - id: c_ca
        kind: coincident
        a: {entity: c, point: end}
        b: {entity: a, point: start}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")
    surfaces = result["topology"]["surfaces"]
    assert len(surfaces) == 1
    assert "query" in surfaces[0]
    assert surfaces[0]["query"].startswith("?")
    assert ":face" in surfaces[0]["query"]


# ── Step 5: plane_transform roundtrip ─────────────────────────────────────────


def test_solver_plane_transform_front():
    """5a: solver returns identity plane_transform for @builtin_plane_front."""
    result = solve(minimal_sketch_yaml('@builtin_plane_front'))["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")
    t = result["plane_transform"]
    assert t["rotation"] == approx([1, 0, 0, 0, 1, 0, 0, 0, 1], abs=1e-9)
    assert t["origin"] == approx([0, 0, 0])


def test_solver_plane_transform_top():
    """5b: solver returns non-identity plane_transform for @builtin_plane_top."""
    result = solve(minimal_sketch_yaml('@builtin_plane_top'))["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")
    t = result["plane_transform"]
    assert t["rotation"] != approx([1, 0, 0, 0, 1, 0, 0, 0, 1], abs=1e-9)
    assert t["origin"] == approx([0, 0, 0])


def test_solver_plane_transform_defaults_to_front():
    """5c: solver returns front plane_transform when plane is absent."""
    result = solve(minimal_sketch_yaml(None))["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")
    t = result["plane_transform"]
    assert t["rotation"] == approx([1, 0, 0, 0, 1, 0, 0, 0, 1], abs=1e-9)


def test_solver_unresolvable_plane_defaults_gracefully():
    """5d: solver does not crash on unresolvable plane query."""
    result = solve(minimal_sketch_yaml('@nonexistent_plane'))["result"]["sketch_1"]
    assert "plane_transform" in result


def two_sketch_doc_with_face_plane() -> str:
    """Return a two-sketch YAML where sketch1's plane is a topology face from sketch0.

    sketch0 is a rectangle on the Top plane so its face plane_transform is not identity.
    sketch1's plane is set to the single face of sketch0 via its ancestry query.
    """
    # Solve sketch0 alone to find its surface query string.
    alone_yaml = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch0
            kind: sketch
            plane: "@builtin_plane_top"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {id: la, kind: line}
              - {id: lb, kind: line}
              - {id: lc, kind: line}
              - {id: ld, kind: line}
            constraints:
              - {id: ca, kind: coincident, a: {entity: la, point: end}, b: {entity: lb, point: start}}
              - {id: cb, kind: coincident, a: {entity: lb, point: end}, b: {entity: lc, point: start}}
              - {id: cc, kind: coincident, a: {entity: lc, point: end}, b: {entity: ld, point: start}}
              - {id: cd, kind: coincident, a: {entity: ld, point: end}, b: {entity: la, point: start}}
              - {id: cf, kind: fixed, target: {entity: la, point: start}}
              - {id: ch, kind: horizontal, target: {entity: la}}
              - {id: cv, kind: vertical, target: {entity: lb}}
              - {id: cl, kind: length, target: {entity: la}, value: 10}
    """)
    r0 = solve(alone_yaml)["result"]["sketch0"]
    assert r0.get("status") != "exception", r0.get("exception")
    face_query = r0["topology"]["surfaces"][0]["query"]

    return textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch0
            kind: sketch
            plane: "@builtin_plane_top"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
          - id: sketch1
            kind: sketch
            plane: "{face_query}"
            initial:
              pt: [1.0, 1.0]
            entities:
              - {{id: pt, kind: point}}
            constraints: []
    """)


def test_solver_plane_from_topology_face():
    """5f/5g: solver resolves a topology face ancestry query as a plane."""
    doc = two_sketch_doc_with_face_plane()
    result = solve(doc)["result"]
    assert "sketch1" in result
    t = result["sketch1"]["plane_transform"]
    # The face lies in the Top plane, so rotation must not be the identity.
    assert t["rotation"] != approx([1, 0, 0, 0, 1, 0, 0, 0, 1], abs=1e-4)
    assert "origin" in t


# ── Step 6: cross-feature constraint queries ───────────────────────────────────

def doc_with_cross_feature_constraint() -> str:
    """Two-sketch YAML where sketch1 has a coincident constraint to sketch0's
    topology face centroid via an ancestry query string."""
    alone_yaml = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch0
            kind: sketch
            plane: "@builtin_plane_front"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {id: la, kind: line}
              - {id: lb, kind: line}
              - {id: lc, kind: line}
              - {id: ld, kind: line}
            constraints:
              - {id: ca, kind: coincident, a: {entity: la, point: end}, b: {entity: lb, point: start}}
              - {id: cb, kind: coincident, a: {entity: lb, point: end}, b: {entity: lc, point: start}}
              - {id: cc, kind: coincident, a: {entity: lc, point: end}, b: {entity: ld, point: start}}
              - {id: cd, kind: coincident, a: {entity: ld, point: end}, b: {entity: la, point: start}}
              - {id: cf, kind: fixed, target: {entity: la, point: start}}
              - {id: ch, kind: horizontal, target: {entity: la}}
              - {id: cv, kind: vertical, target: {entity: lb}}
              - {id: cl, kind: length, target: {entity: la}, value: 10}
    """)
    r0 = solve(alone_yaml)["result"]["sketch0"]
    assert r0.get("status") != "exception", r0.get("exception")
    face_query = r0["topology"]["surfaces"][0]["query"]

    return textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch0
            kind: sketch
            plane: "@builtin_plane_front"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
          - id: sketch1
            kind: sketch
            plane: "@builtin_plane_front"
            initial:
              pt: [0.0, 0.0]
            entities:
              - {{id: pt, kind: point}}
            constraints:
              - id: c1
                kind: coincident
                a: "$ptxy"
                b: "{face_query}"
    """)


def test_coincident_constraint_to_topology_face():
    """6d: solver resolves an ancestry-query constraint target without crashing."""
    doc = doc_with_cross_feature_constraint()
    result = solve(doc)["result"]
    assert result.get("sketch1", {}).get("status") in ("fully_constrained", "underconstrained")
    # The point should have snapped to the face centroid (5, 5) for the 10×10 rect
    geom = result["sketch1"].get("geometry", {})
    assert "pt" in geom
    pt_x, pt_y = geom["pt"]
    assert abs(pt_x - 5.0) < 1e-3, f"Expected pt.x ≈ 5.0, got {pt_x}"
    assert abs(pt_y - 5.0) < 1e-3, f"Expected pt.y ≈ 5.0, got {pt_y}"
