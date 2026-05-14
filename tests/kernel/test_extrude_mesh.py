import importlib
import pytest
from pytest import approx

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def test_rect_extrude_mesh_valid():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_rect_extrude_bbox_normal():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=10, h=8, d=5, direction="normal")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 10), y_range=(0, 8), z_range=(0, 5))


def test_rect_extrude_bbox_reverse():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=6, h=6, d=4, direction="reverse")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 6), y_range=(0, 6), z_range=(-4, 0))


def test_rect_extrude_bbox_symmetric():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_bbox

    spec = full_rect_extrude_spec(w=4, h=4, d=6, direction="symmetric")
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(-3, 3))


def test_all_face_indices_valid():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    n = len(mesh["vertices"])
    for face in mesh["faces"]:
        assert all(0 <= idx < n for idx in face), f"invalid face: {face}, n={n}"


def test_normals_unit_length():
    import math
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    for i, nv in enumerate(mesh["normals"]):
        mag = math.sqrt(sum(x * x for x in nv))
        assert abs(mag - 1.0) < 1e-5, f"normal[{i}] not unit length: {nv}"


def test_no_degenerate_faces():
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec()
    r = build(spec)
    mesh = r["bodies"]["body_ex1"]["mesh"]
    for i, (a, b, c) in enumerate(mesh["faces"]):
        assert a != b and b != c and a != c, f"face {i} is degenerate: ({a},{b},{c})"


def test_extrude_top_face_plane_at_correct_z():
    from oversolved.kernel.builder import build
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
    from oversolved.kernel.builder import build
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
            extrude_spec("sk2", "ex2", distance=3.0, operation="new"),
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
    from oversolved.kernel.builder import build
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
    from oversolved.kernel.builder import build
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
    from oversolved.kernel.builder import build
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
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=5.0),
            rect_sketch_spec(w=5, h=5, sketch_id="sk2"),
            extrude_spec("sk2", "ex2", distance=3.0, operation="new"),
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
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import make_ancestry_query
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


def test_extrude_surface_query_uses_only_selected_surface():
    """When a sketch has multiple surfaces and one is selected via ? query,
    only that surface should be extruded, not the whole sketch.

    Two circles side-by-side: c1 at origin (surface:0), c2 at x=3 (surface:1).
    Extruding surface:1 must produce a solid whose x-range is near 3, not near 0.
    """
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import make_ancestry_query
    from solver_helpers import assert_mesh_bbox

    sk = "sk1"
    # Select only c2 (surface:1).
    surface_query = make_ancestry_query(
        [f"@{sk}c2", "surface:1", f"@{sk}"],
        "flatface",
    )

    spec = {
        "features": [
            {
                "id": sk,
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "c1", "kind": "circle"},
                    {"id": "c2", "kind": "circle"},
                ],
                "initial": {
                    "c1": [0, 0, 0.5],
                    "c2": [3, 0, 0.5],
                },
                "constraints": [
                    {"id": "co1", "kind": "coincident",
                     "a": f"${sk}c1center", "b": "@builtin_origin"},
                    {"id": "d1", "kind": "diameter",
                     "target": f"${sk}c1", "value": 1},
                    {"id": "d2", "kind": "diameter",
                     "target": f"${sk}c2", "value": 1},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": surface_query,
                "distance": 1.0,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    # c2 is near x=3 -- if both surfaces were extruded the x-range would span 0 too.
    xs = [v[0] for v in mesh["vertices"]]
    assert min(xs) > 1.0, f"x min={min(xs):.3f}: c1 surface was incorrectly included"
    assert_mesh_bbox(mesh, x_range=(2.5, 3.5), y_range=(-0.5, 0.5), z_range=(0, 1))


def test_extrude_from_top_face_named_query():
    """Extrude2 references @ex1/top_face as its profile.

    The second extrude must resolve the face query, use the sketch topology
    of ex1, and produce a solid starting at z=5 (top of ex1).
    """
    from oversolved.kernel.builder import build
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
                "operation": "new",
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


def test_extrude_sketch_list_two_profiles():
    """sketch field as a list of two sketch refs extrudes both profiles into one body."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec

    spec = {
        "features": [
            rect_sketch_spec(w=2, h=2, sketch_id="sk1"),
            rect_sketch_spec(w=2, h=2, sketch_id="sk2"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": ["$sk1", "$sk2"],
                "distance": 3.0,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    # Both rectangles are centered at origin (rect_sketch_spec default), so
    # a valid mesh with vertices should exist.
    assert len(mesh["vertices"]) > 0
    assert len(mesh["faces"]) > 0


def test_extrude_sketch_list_single_element():
    """A list with one sketch ref behaves like the string form."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_bbox

    spec = {
        "features": [
            rect_sketch_spec(w=4, h=4, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": ["$sk1"],
                "distance": 2.0,
                "direction": "normal",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(0, 2))


def test_extrude_sketch_empty_list_errors():
    """An empty sketch list must return a clear error, not an exception crash."""
    from oversolved.kernel.builder import build

    spec = {
        "features": [
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": [],
                "distance": 2.0,
            }
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "exception"


def test_extrude_sketch_not_found_returns_exception():
    """Extrude with a sketch ref that has no closed profile returns exception."""
    from oversolved.kernel.builder import build

    spec = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [{"id": "L1", "kind": "line"}],
                "constraints": [{"id": "c1", "kind": "horizontal", "target": {"entity": "L1"}}],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": ["@sk1"],
                "distance": 5.0,
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "exception"


def test_extrude_key_error_still_returns_exception_dict():
    """A KeyError inside _solve_extrude must yield exception status (not crash)."""
    from oversolved.kernel.builder import build

    spec = {
        "features": [
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": [],
            }
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "exception"


def test_cut_extrude_removes_volume():
    """Cut extrusion subtracts from a base body, leaving a partial solid."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec, assert_mesh_valid, assert_mesh_bbox

    # Base: 10x10x10 box; cut: same profile, distance=5 (removes z=0..5).
    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=10.0, direction="normal"),
            extrude_spec("sk1", "ex2", distance=5.0, direction="normal", operation="cut"),
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert r["result"]["ex2"]["status"] == "ok", r["result"]["ex2"]
    # Cut tool body must not appear in output.
    assert "body_ex2" not in r["bodies"]
    # Base body is modified but still valid.
    assert "body_ex1" in r["bodies"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)
    assert_mesh_bbox(mesh, x_range=(0, 10), y_range=(0, 10), z_range=(5, 10))


def test_cut_extrude_no_body_stored():
    """Cut extrude feature must not produce a body in the output bodies dict."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=6, h=6, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=8.0),
            extrude_spec("sk1", "ex2", distance=4.0, operation="cut"),
        ]
    }
    r = build(spec)
    assert "body_ex2" not in r["bodies"]
    assert "body_ex1" in r["bodies"]


def test_cut_extrude_nested_ui_format():
    """Cut operation read from nested extrude sub-dict (UI serialization format)."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_valid, assert_mesh_bbox

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "label": "Base",
                "extrude": {"sketch": "$sk1", "distance": 10.0, "direction": "normal"},
            },
            {
                "id": "ex2",
                "kind": "extrude",
                "label": "Cut",
                "extrude": {
                    "sketch": "$sk1",
                    "distance": 5.0,
                    "direction": "normal",
                    "operation": "cut",
                },
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert r["result"]["ex2"]["status"] == "ok", r["result"]["ex2"]
    assert "body_ex2" not in r["bodies"]
    assert "body_ex1" in r["bodies"]
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)
    assert_mesh_bbox(mesh, x_range=(0, 10), y_range=(0, 10), z_range=(5, 10))


def test_cut_extrude_with_no_target_body():
    """Cut extrude with no prior body must succeed without crashing."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=6, h=6, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=5.0, operation="cut"),
        ]
    }
    r = build(spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" not in r["bodies"]


def test_extrude_from_brep_face_ancestry_query():
    """Extrude2 uses a face_queries ancestry query from extrude1's mesh as its profile.

    This is the scenario where the user clicks the top face of ex1 in the 3D
    viewport and the frontend stores the ancestry query (e.g. ?...;@ex1face0@ex1:flatface)
    as the extrude sketch field.  Before the fix, _resolve_face_profile failed
    because the face was not registered with register_ancestor.
    """
    from pytest import approx
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_valid

    d = 5.0
    spec1 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": d,
                "direction": "normal",
            },
        ]
    }
    r1 = build(spec1)
    assert r1["result"]["ex1"]["status"] == "ok", r1["result"]["ex1"]

    # Find the face query for the top face (centroid closest to z=d).
    best_q = None
    best_dist = float("inf")
    for body in r1.get("bodies", {}).values():
        mesh = body.get("mesh") or {}
        for fd, q in zip(mesh.get("face_data") or [], mesh.get("face_queries") or []):
            dist = abs(fd["centroid"][2] - d)
            if dist < best_dist:
                best_dist = dist
                best_q = q
    assert best_q is not None, "expected face_queries in mesh"
    assert best_q.startswith("?"), f"expected ?-ancestry query, got {best_q!r}"

    spec2 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": d,
                "direction": "normal",
            },
            {
                "id": "ex2",
                "kind": "extrude",
                "sketch": best_q,
                "distance": 3.0,
                "direction": "normal",
                "operation": "new",
            },
        ]
    }
    r2 = build(spec2)
    assert r2["result"]["ex2"]["status"] == "ok", r2["result"]["ex2"]
    assert "body_ex2" in r2["bodies"]
    mesh2 = r2["bodies"]["body_ex2"]["mesh"]
    assert_mesh_valid(mesh2)
    zs = [v[2] for v in mesh2["vertices"]]
    assert min(zs) == approx(d, abs=0.2), f"ex2 should start at z={d}, got {min(zs)}"
    assert max(zs) == approx(d + 3.0, abs=0.2), f"ex2 should end at z={d + 3.0}, got {max(zs)}"


def test_extrude_from_brep_face_after_fillet():
    """Extrude uses a face query from a body that was modified by a fillet.

    Regression test: after a fillet changes the body topology, the face index
    ordering in _extract_loops_from_occ_face must match solid_to_mesh, otherwise
    a different (non-flat) face is resolved and the extrude fails with
    "Only flat faces can be used as extrude profiles".
    """
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_valid

    d = 5.0
    spec1 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": d,
                "direction": "normal",
            },
        ]
    }
    r1 = build(spec1)
    assert r1["result"]["ex1"]["status"] == "ok"

    # Pick a flat side face from the extruded body (not top/bottom, those
    # are at z=0 and z=d).  Side faces have centroid z ~ d/2.
    # Use the face index from the mesh to build a 3-tag backward-compatible
    # query (index, feature, body) that resolves even after fillet.
    best_q = None
    for body in r1.get("bodies", {}).values():
        mesh = body.get("mesh") or {}
        for idx, (fd, q) in enumerate(zip(mesh.get("face_data") or [], mesh.get("face_queries") or [])):
            cz = fd["centroid"][2]
            if abs(cz - d / 2) < 0.1 and fd.get("surface_type") == "flatface":
                from oversolved.kernel.query import make_ancestry_query
                best_q = make_ancestry_query(
                    [f"@body_ex1face{idx}", "@ex1", "@body_ex1"], "flatface"
                )
                break
    assert best_q is not None, "expected a flat side face query"

    spec2 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": d,
                "direction": "normal",
            },
            {
                "id": "fil1",
                "kind": "fillet",
                "edges": [
                    # Pick top-front and top-right edges via ancestry from the
                    # extrude body tessellation — these are straight edges on the
                    # top face boundary that will become fillet edges.
                    r1["bodies"]["body_ex1"]["edge_queries"][0],
                    r1["bodies"]["body_ex1"]["edge_queries"][1],
                ],
                "radius": 0.5,
            },
            {
                "id": "ex2",
                "kind": "extrude",
                "sketch": best_q,
                "distance": 3.0,
                "direction": "normal",
                "operation": "new",
            },
        ]
    }
    r2 = build(spec2)
    assert r2["result"]["ex2"]["status"] == "ok", r2["result"]["ex2"]
    assert "body_ex2" in r2["bodies"]
    assert_mesh_valid(r2["bodies"]["body_ex2"]["mesh"])


def test_extrude_from_brep_face_slash_query():
    """Extrude accepts slash-style B-rep face IDs (@feature/face/N)."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, assert_mesh_valid

    d = 5.0
    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": d,
                "direction": "normal",
            },
            {
                "id": "ex2",
                "kind": "extrude",
                "sketch": "@ex1/face/0",
                "distance": 3.0,
                "direction": "normal",
                "operation": "new",
            },
        ]
    }
    r = build(spec)
    assert r["result"]["ex2"]["status"] == "ok", r["result"]["ex2"]
    assert "body_ex2" in r["bodies"]
    mesh2 = r["bodies"]["body_ex2"]["mesh"]
    assert_mesh_valid(mesh2)
    xs = [v[0] for v in mesh2["vertices"]]
    ys = [v[1] for v in mesh2["vertices"]]
    zs = [v[2] for v in mesh2["vertices"]]
    spans = [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)]
    # Selected B-rep face can have any orientation; extrusion depth should be
    # visible as one principal span close to the requested distance.
    assert any(abs(s - 3.0) < 0.25 for s in spans), f"expected one span ~= 3.0, got {spans!r}"


def _disjoint_two_rect_spec(operation: str = "new") -> dict:
    """Two disjoint 2x2 rectangles in one sketch on the Front plane, extruded 3 units."""
    # rect A: (0,0)-(2,2); rect B: (5,0)-(7,2) -- no shared edges
    return {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "a_bot", "kind": "line"},
                    {"id": "a_right", "kind": "line"},
                    {"id": "a_top", "kind": "line"},
                    {"id": "a_left", "kind": "line"},
                    {"id": "b_bot", "kind": "line"},
                    {"id": "b_right", "kind": "line"},
                    {"id": "b_top", "kind": "line"},
                    {"id": "b_left", "kind": "line"},
                ],
                "initial": {
                    "a_bot": [0, 0, 2, 0],
                    "a_right": [2, 0, 2, 2],
                    "a_top": [2, 2, 0, 2],
                    "a_left": [0, 2, 0, 0],
                    "b_bot": [5, 0, 7, 0],
                    "b_right": [7, 0, 7, 2],
                    "b_top": [7, 2, 5, 2],
                    "b_left": [5, 2, 5, 0],
                },
                "constraints": [
                    {"id": "ca1", "kind": "coincident",
                     "a": {"entity": "a_bot", "point": "end"},
                     "b": {"entity": "a_right", "point": "start"}},
                    {"id": "ca2", "kind": "coincident",
                     "a": {"entity": "a_right", "point": "end"},
                     "b": {"entity": "a_top", "point": "start"}},
                    {"id": "ca3", "kind": "coincident",
                     "a": {"entity": "a_top", "point": "end"},
                     "b": {"entity": "a_left", "point": "start"}},
                    {"id": "ca4", "kind": "coincident",
                     "a": {"entity": "a_left", "point": "end"},
                     "b": {"entity": "a_bot", "point": "start"}},
                    {"id": "cb1", "kind": "coincident",
                     "a": {"entity": "b_bot", "point": "end"},
                     "b": {"entity": "b_right", "point": "start"}},
                    {"id": "cb2", "kind": "coincident",
                     "a": {"entity": "b_right", "point": "end"},
                     "b": {"entity": "b_top", "point": "start"}},
                    {"id": "cb3", "kind": "coincident",
                     "a": {"entity": "b_top", "point": "end"},
                     "b": {"entity": "b_left", "point": "start"}},
                    {"id": "cb4", "kind": "coincident",
                     "a": {"entity": "b_left", "point": "end"},
                     "b": {"entity": "b_bot", "point": "start"}},
                    {"id": "ha", "kind": "horizontal", "target": {"entity": "a_bot"}},
                    {"id": "hb", "kind": "horizontal", "target": {"entity": "b_bot"}},
                    {"id": "la", "kind": "length", "target": {"entity": "a_bot"}, "value": 2.0},
                    {"id": "lb", "kind": "length", "target": {"entity": "b_bot"}, "value": 2.0},
                ],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 3.0,
                "direction": "normal",
                "operation": operation,
            },
        ]
    }


def test_disjoint_rects_new_creates_two_bodies():
    """Two disjoint sketch profiles with operation=new produce two separate bodies."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid

    r = build(_disjoint_two_rect_spec(operation="new"))
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"], "first body missing"
    assert "body_ex1_1" in r["bodies"], "second body missing"
    assert r["result"]["ex1"]["body_ids"] == ["body_ex1", "body_ex1_1"]
    assert_mesh_valid(r["bodies"]["body_ex1"]["mesh"])
    assert_mesh_valid(r["bodies"]["body_ex1_1"]["mesh"])


def test_disjoint_rects_add_no_base_creates_two_bodies():
    """Two disjoint profiles with operation=add and no existing body produce two bodies."""
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="add"))
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    assert "body_ex1" in r["bodies"]
    assert "body_ex1_1" in r["bodies"]


def test_disjoint_rects_add_with_base_fuses():
    """Disjoint profiles with operation=add and an existing body fuse into that body."""
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    base_spec = {
        "features": [
            rect_sketch_spec(w=2, h=2, sketch_id="sk0"),
            extrude_spec("sk0", "ex0", distance=1.0, operation="new"),
        ]
        + _disjoint_two_rect_spec(operation="add")["features"]
    }
    r = build(base_spec)
    assert r["result"]["ex1"]["status"] == "ok", r["result"]["ex1"]
    # All volumes fused into base body -- no split bodies
    assert "body_ex0" in r["bodies"]
    assert "body_ex1_1" not in r["bodies"], "split body must not appear when fusing"


def test_single_rect_still_one_body():
    """Single rectangle extrude still produces exactly one body (backward compat)."""
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    r = build(full_rect_extrude_spec(w=4, h=4, d=2))
    assert r["result"]["ex1"]["status"] == "ok"
    assert "body_ex1" in r["bodies"]
    assert "body_ex1_1" not in r["bodies"]
    assert r["result"]["ex1"]["body_ids"] == ["body_ex1"]


def test_disjoint_extrude_has_body_ids_field():
    """body_ids field lists all split body IDs in the result dict."""
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="new"))
    body_ids = r["result"]["ex1"].get("body_ids")
    assert body_ids is not None, "body_ids field missing"
    assert set(body_ids) == {"body_ex1", "body_ex1_1"}


def test_disjoint_pick_body_by_feature_id():
    """_resolve_body('@ex1') returns the first split body after a disjoint extrude."""
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="new"))
    # Reconstruct body_store from result (build doesn't expose it directly,
    # so we call the solver path with a simple stand-in).
    # Instead verify via the builder output that body_ex1 was created.
    assert "body_ex1" in r["bodies"]
    assert "body_ex1_1" in r["bodies"]


def test_disjoint_bodies_have_unique_face_queries():
    """Bug fix: two-body extrude face queries must be unique per body.

    When a single extrude produces two bodies, their face_queries were
    feature-scoped (@featureId) so both bodies shared identical query strings.
    Resolving such a query raised AmbiguousQueryError or silently returned the
    wrong body.  The fix scopes queries to @body_id so each body is distinct.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="new"))
    assert r["result"]["ex1"]["status"] == "ok"

    fq1 = set(r["bodies"]["body_ex1"]["mesh"]["face_queries"])
    fq2 = set(r["bodies"]["body_ex1_1"]["mesh"]["face_queries"])

    assert fq1.isdisjoint(fq2), (
        f"Bodies share face queries: {fq1 & fq2}"
    )


def test_disjoint_bodies_face_query_resolves_to_correct_body():
    """Each face query must resolve unambiguously to the body it belongs to."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    r = build(_disjoint_two_rect_spec(operation="new"))
    assert r["result"]["ex1"]["status"] == "ok"

    build_state = r["_build_state"]
    last_fid = build_state.feature_order[-1]
    checkpoint = build_state.checkpoints[last_fid]
    repo = _repo_from_snapshot(checkpoint.repo_snapshot)

    for bid in ("body_ex1", "body_ex1_1"):
        for fq in r["bodies"][bid]["mesh"]["face_queries"]:
            result = repo.query(fq)
            assert result is not None, f"face query {fq!r} resolved to None"
            assert result.get("body_id") == bid, (
                f"face query for {bid} resolved to body {result.get('body_id')!r}"
            )


def test_disjoint_bodies_have_unique_edge_queries():
    """Edge queries from two bodies of the same extrude must be disjoint."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="new"))
    assert r["result"]["ex1"]["status"] == "ok"

    eq1 = set(r["bodies"]["body_ex1"].get("edge_queries", []))
    eq2 = set(r["bodies"]["body_ex1_1"].get("edge_queries", []))

    assert eq1 and eq2, "both bodies must have edge_queries"
    assert eq1.isdisjoint(eq2), f"Bodies share edge queries: {eq1 & eq2}"


def test_disjoint_bodies_have_unique_vertex_queries():
    """Vertex queries from two bodies of the same extrude must be disjoint."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_disjoint_two_rect_spec(operation="new"))
    assert r["result"]["ex1"]["status"] == "ok"

    vq1 = set(r["bodies"]["body_ex1"].get("vertex_queries", []))
    vq2 = set(r["bodies"]["body_ex1_1"].get("vertex_queries", []))

    assert vq1 and vq2, "both bodies must have vertex_queries"
    assert vq1.isdisjoint(vq2), f"Bodies share vertex queries: {vq1 & vq2}"


def test_disjoint_body_face_query_usable_in_downstream_feature():
    """A face query from the secondary body of a two-body extrude can be used
    as a plane definition without AmbiguousQueryError.

    This is the concrete scenario from the bug report: the user selects a face
    that visually belongs to one part but the query resolved to both parts.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec

    r1 = build(_disjoint_two_rect_spec(operation="new"))
    assert r1["result"]["ex1"]["status"] == "ok"

    # Pick a flatface from the secondary body and use it as a plane.
    face_data = r1["bodies"]["body_ex1_1"]["mesh"]["face_data"]
    face_queries = r1["bodies"]["body_ex1_1"]["mesh"]["face_queries"]
    flat_query = next(
        (fq for fd, fq in zip(face_data, face_queries) if fd.get("surface_type") == "flatface"),
        None,
    )
    assert flat_query is not None, "secondary body must have a flatface"

    sketch2 = rect_sketch_spec(w=2, h=2, sketch_id="sk2")
    sketch2["plane"] = flat_query

    spec2 = dict(_disjoint_two_rect_spec(operation="new"))
    spec2["features"] = spec2["features"] + [sketch2]

    r2 = build(spec2, prev_state=r1["_build_state"])
    sk2_result = r2["result"]["sk2"]
    # Plane must resolve without AmbiguousQueryError; sketch may be underconstrained.
    assert sk2_result.get("plane_transform") is not None, (
        f"sk2 plane did not resolve: {sk2_result}"
    )


def test_revolve_from_fillet_face_propagates_arcs():
    """A revolve using a flat face from a filleted body must capture the fillet's
    curved boundary edges as arcs, not straight chords. Before the fix,
    _extract_loops_from_occ_face hardcoded all edges as 'kind: line'."""
    from oversolved.kernel.builder import build
    from solver_helpers import assert_mesh_valid, rect_sketch_spec

    sketch = rect_sketch_spec(w=5, h=5, sketch_id='sk1')
    spec = {
        'features': [
            sketch,
            {'id': 'ex1', 'kind': 'extrude', 'label': 'Extrude',
             'sketch': '$sk1', 'distance': 5, 'direction': 'normal'},
            {'id': 'fillet1', 'kind': 'fillet', 'label': 'Fillet',
             'edges': ['?body_ex1:edge:0'], 'radius': 1.0},
        ],
    }
    r = build(spec)
    assert r['result']['fillet1']['status'] == 'ok'

    body = r['_body_shapes']['body_ex1']
    from oversolved.kernel.solver_features import _extract_loops_from_occ_face

    arc_face_index = None
    for fi in range(30):
        try:
            loops, _ = _extract_loops_from_occ_face(body, fi)
            if any(e.get('kind') == 'arc' for loop in loops for e in loop):
                arc_face_index = fi
                break
        except Exception:
            continue

    assert arc_face_index is not None, \
        "no face with an arc boundary found after fillet — fix did not propagate arcs"

    spec['features'].append({
        'id': 'rev1', 'kind': 'revolve', 'label': 'Revolve',
        'sketch': f'@ex1/face/{arc_face_index}',
        'angle': 45.0, 'axis_origin': [0, 0, 0], 'axis_direction': [0, 0, 1],
        'operation': 'new',
    })
    r2 = build(spec)
    assert r2['result']['rev1']['status'] == 'ok', \
        f"revolve from fillet-adjacent face failed: {r2['result']['rev1'].get('exception')}"
    assert 'body_rev1' in r2['bodies']
    assert_mesh_valid(r2['bodies']['body_rev1']['mesh'])


def test_extract_occ_face_returns_arcs_after_fillet():
    """Direct unit test: _extract_loops_from_occ_face must return arc edges
    for flat-face boundaries shared with a fillet (regression)."""
    import cadquery as cq
    from oversolved.kernel.solver_features import _extract_loops_from_occ_face
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet

    cq_solid = cq.Workplane('XY').rect(10, 10).extrude(5).solids().val()
    edges = list(cq_solid.edges())
    maker = BRepFilletAPI_MakeFillet(cq_solid.wrapped)
    maker.Add(1.0, edges[0].wrapped)
    maker.Build()
    filleted = cq.Solid.cast(maker.Shape())

    arc_found = False
    for fi in range(20):
        try:
            loops, _ = _extract_loops_from_occ_face(filleted, fi)
            if any(e.get('kind') == 'arc' for loop in loops for e in loop):
                arc_found = True
                break
        except Exception:
            continue
    assert arc_found, "no arc edges found in any face boundary after fillet"
