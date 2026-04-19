import pytest
from pytest import approx

pytestmark = pytest.mark.skipif(
    not __import__("importlib").util.find_spec("OCP"), reason="OCP not installed"
)


def test_rect_extrude_mesh_valid():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_rect_extrude_bbox_normal():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=10, h=8, d=5, direction="normal")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 10), y_range=(0, 8), z_range=(0, 5))


def test_rect_extrude_bbox_reverse():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=6, h=6, d=4, direction="reverse")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 6), y_range=(0, 6), z_range=(-4, 0))


def test_rect_extrude_bbox_symmetric():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=4, h=4, d=6, direction="symmetric")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(-3, 3))


def test_all_face_indices_valid():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    n = len(mesh["vertices"])
    for face in mesh["faces"]:
        assert all(0 <= idx < n for idx in face), f"invalid face: {face}, n={n}"


def test_normals_unit_length():
    import math
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    for i, nv in enumerate(mesh["normals"]):
        mag = math.sqrt(sum(x * x for x in nv))
        assert abs(mag - 1.0) < 1e-5, f"normal[{i}] not unit length: {nv}"


def test_no_degenerate_faces():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    for i, (a, b, c) in enumerate(mesh["faces"]):
        assert a != b and b != c and a != c, f"face {i} is degenerate: ({a},{b},{c})"


def test_extrude_top_face_plane_at_correct_z():
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=7.0),
            {
                "id": "plane1",
                "kind": "plane",
                "definition": {
                    "mode": "offset",
                    "reference": "@ex1/top_face",
                    "distance": 0.0,
                },
            },
        ]
    }
    r = build(spec)
    assert r["result"]["plane1"]["status"] == "ok", r["result"]["plane1"]
    plane = r["result"]["plane1"]["plane"]
    assert plane["origin"][2] == approx(7.0, abs=0.1), (
        f"top_face plane origin z should be 7.0, got {plane['origin'][2]}"
    )


def test_two_extrudes_stacked():
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=5.0),
            {
                "id": "sk2",
                "kind": "sketch",
                "plane": "@ex1/top_face",
                "entities": [
                    {"id": "bottom", "kind": "line"},
                    {"id": "right", "kind": "line"},
                    {"id": "top", "kind": "line"},
                    {"id": "left", "kind": "line"},
                ],
                "initial": {
                    "bottom": [0, 0, 4, 0],
                    "right": [4, 0, 4, 4],
                    "top": [4, 4, 0, 4],
                    "left": [0, 4, 0, 0],
                },
                "constraints": [
                    {
                        "id": "c1",
                        "kind": "coincident",
                        "a": {"entity": "bottom", "point": "end"},
                        "b": {"entity": "right", "point": "start"},
                    },
                    {
                        "id": "c2",
                        "kind": "coincident",
                        "a": {"entity": "right", "point": "end"},
                        "b": {"entity": "top", "point": "start"},
                    },
                    {
                        "id": "c3",
                        "kind": "coincident",
                        "a": {"entity": "top", "point": "end"},
                        "b": {"entity": "left", "point": "start"},
                    },
                    {
                        "id": "c4",
                        "kind": "coincident",
                        "a": {"entity": "left", "point": "end"},
                        "b": {"entity": "bottom", "point": "start"},
                    },
                    {"id": "c5", "kind": "horizontal", "target": {"entity": "bottom"}},
                    {"id": "c6", "kind": "horizontal", "target": {"entity": "top"}},
                    {"id": "c7", "kind": "vertical", "target": {"entity": "right"}},
                    {"id": "c8", "kind": "vertical", "target": {"entity": "left"}},
                    {
                        "id": "c9",
                        "kind": "length",
                        "target": {"entity": "bottom"},
                        "value": 4.0,
                    },
                    {
                        "id": "c10",
                        "kind": "length",
                        "target": {"entity": "left"},
                        "value": 4.0,
                    },
                ],
            },
            extrude_spec("sk2", "ex2", distance=3.0),
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok"
    assert r["result"]["ex2"]["status"] == "ok"
    mesh2 = r["bodies"]["body_ex2"]["mesh"]
    zs = [v[2] for v in mesh2["vertices"]]
    assert min(zs) == approx(5.0, abs=0.2), (
        f"ex2 should start at z=5, got min z={min(zs)}"
    )
    assert max(zs) == approx(8.0, abs=0.2), (
        f"ex2 should end at z=8, got max z={max(zs)}"
    )


def test_extrude_sketch_on_builtin_plane_bare_id():
    """Extrude with sketch plane given as bare builtin ID ('Top', 'Front', 'Right').

    Regression: handleAddSketch in the UI writes plane: 'Top' (no @ prefix).
    The solver must resolve these bare IDs to the correct builtin planes.
    """
    from oversolved.builder import build
    from solver_helpers import assert_mesh_bbox

    # Circle sketch (r=0.5 centred at origin) on the Top plane.
    # Top plane: origin=[0,0,0], normal=[0,1,0] → extrude normal goes in +Y.
    spec = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "Top",  # bare ID as written by the UI
                "entities": [{"id": "c1", "kind": "circle"}],
                "initial": {"c1": [0, 0, 0.5]},
                "constraints": [
                    {"id": "co1", "kind": "coincident",
                     "a": "$sk1/c1center", "b": "@builtin_origin"},
                    {"id": "d1", "kind": "diameter", "target": "$sk1/c1", "value": 1},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 2,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["sk1"]["status"] != "exception", r["result"]["sk1"]
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    # Top plane extrudes in +Y direction, so y spans [0, 2]
    assert_mesh_bbox(mesh, x_range=(-0.5, 0.5), y_range=(0, 2), z_range=(-0.5, 0.5))


def test_extrude_nested_ui_format():
    """Regression: UI serializes extrude as {kind, id, extrude: {sketch, distance, direction}}.

    The solver must read sketch/distance/direction from the nested sub-dict.
    """
    from oversolved.builder import build
    from solver_helpers import assert_mesh_bbox

    spec = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "Top",
                "entities": [{"id": "c1", "kind": "circle"}],
                "initial": {"c1": [0, 0, 0.5]},
                "constraints": [
                    {"id": "co1", "kind": "coincident",
                     "a": "$sk1/c1center", "b": "@builtin_origin"},
                    {"id": "d1", "kind": "diameter", "target": "$sk1/c1", "value": 1},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "label": "extrude 1",
                "extrude": {
                    "sketch": "$sk1",
                    "distance": 2,
                    "direction": "normal",
                },
            },
        ]
    }
    r = build(spec)
    assert r["result"]["sk1"]["status"] != "exception", r["result"]["sk1"]
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(-0.5, 0.5), y_range=(0, 2), z_range=(-0.5, 0.5))


def test_extrude_circle_sketch_with_ghost_line_constraints():
    """Regression (bugreport 20260419): sketch has old-format constraints referencing
    non-existent line entities alongside a valid circle entity.

    The solver must ignore the ghost constraints, solve the circle, and produce a
    valid extruded cylinder. The extrude must not return status 'exception' and the
    body must have a mesh.
    """
    from oversolved.builder import build
    from solver_helpers import assert_mesh_valid

    spec = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "Top",
                "entities": [{"id": "circ1", "kind": "circle"}],
                "initial": {"circ1": [0, 0, 0.5]},
                "constraints": [
                    # Valid: circle center at origin (old-format, no slash)
                    {"id": "c_co", "kind": "coincident",
                     "a": "$sk1circ1center", "b": "@builtin_origin"},
                    {"id": "c_diam", "kind": "diameter",
                     "target": "$sk1circ1", "value": 1},
                    # Ghost constraints referencing non-existent line entities
                    {"id": "c_ghost1", "kind": "coincident",
                     "a": "$sk1line1end", "b": "$sk1line2start"},
                    {"id": "c_ghost2", "kind": "equal_length",
                     "a": "$sk1line1", "b": "$sk1line3"},
                    {"id": "c_ghost3", "kind": "horizontal",
                     "target": "$sk1line1"},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "label": "extrude 1",
                "extrude": {
                    "sketch": "$sk1",
                    "distance": 1,
                    "direction": "normal",
                },
            },
        ]
    }
    r = build(spec)
    assert r["result"]["sk1"]["status"] != "exception", r["result"]["sk1"]
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    body = r["bodies"].get("body_ex1")
    assert body is not None, "body_ex1 missing from bodies"
    assert body.get("mesh") is not None, "extrude body has no mesh"
    assert_mesh_valid(body["mesh"])


def test_two_independent_extrudes_produce_two_bodies():
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=5.0),
            rect_sketch_spec(w=5, h=5, sketch_id="sk2"),
            extrude_spec("sk2", "ex2", distance=3.0),
        ]
    }
    r = build(spec)
    assert "body_ex1" in r["bodies"]
    assert "body_ex2" in r["bodies"]
    assert len(r["bodies"]) == 2


def test_extrude_from_sketch_surface_query():
    """Extrude uses a ?-ancestry query for a sketch surface flatface as the profile.

    This reproduces the 2026-04-19 bug where clicking a sketch surface face in the
    viewport stored a ?-prefixed ancestry query in the extrude sketch field, causing
    'Cannot resolve profile from' exception because _resolve_face_profile only handled
    the @ branch after checking for body_id/face_index.
    """
    from oversolved.builder import build
    from oversolved.query import make_ancestry_query
    from solver_helpers import assert_mesh_valid

    sketch_id = "sk1"
    circle_id = "c1"
    # The topology code builds the surface query with these ancestor ids.
    surface_query = make_ancestry_query(
        [f"@{sketch_id}{circle_id}", "surface:0", f"@{sketch_id}"],
        "flatface",
    )

    spec = {
        "features": [
            {
                "id": sketch_id,
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [{"id": circle_id, "kind": "circle"}],
                "initial": {circle_id: [0, 0, 0.5]},
                "constraints": [
                    {"id": "co1", "kind": "coincident",
                     "a": f"${sketch_id}{circle_id}center", "b": "@builtin_origin"},
                    {"id": "d1", "kind": "diameter",
                     "target": f"${sketch_id}{circle_id}", "value": 1},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": surface_query,
                "distance": 2.0,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["sk1"]["status"] != "exception", r["result"]["sk1"]
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])


def test_extrude_from_top_face_named_query():
    """Extrude2 references @ex1/top_face as its profile.

    The second extrude must resolve the face query, use the sketch topology
    of ex1, and produce a solid starting at z=5 (top of ex1).
    """
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_valid

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 5.0,
                "direction": "normal",
            },
            {
                "id": "ex2",
                "kind": "extrude",
                "sketch": "@ex1/top_face",
                "distance": 3.0,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert r["result"]["ex2"]["status"] == "ok", r["result"]["ex2"]
    assert "body_ex2" in r["bodies"]
    mesh2 = r["bodies"]["body_ex2"]["mesh"]
    assert_mesh_valid(mesh2)
    zs = [v[2] for v in mesh2["vertices"]]
    from pytest import approx
    assert min(zs) == approx(5.0, abs=0.2), f"ex2 should start at z=5, got {min(zs)}"
    assert max(zs) == approx(8.0, abs=0.2), f"ex2 should end at z=8, got {max(zs)}"
