import pytest

pytestmark = pytest.mark.skipif(
    not __import__("importlib").util.find_spec("OCP"), reason="OCP not installed"
)


# ---------------------------------------------------------------------------
# Fillet tests
# ---------------------------------------------------------------------------


def test_fillet_single_edge():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok", f"build failed: {r['result']['fillet1'].get('exception')}"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_fillet_multiple_edges():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0", "?body_ex1:edge:1"],
        "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_fillet_zero_radius_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 0,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "exception"
    assert "radius must be positive" in r["result"]["fillet1"].get("exception", "")


def test_fillet_negative_radius_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": -1,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "exception"
    assert "radius must be positive" in r["result"]["fillet1"].get("exception", "")


def test_fillet_empty_edges_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": [],
        "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "exception"
    assert "requires at least one edge" in r["result"]["fillet1"].get("exception", "")


def test_fillet_chain_after_extrude():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_fillet_updates_body():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    r_before = build(spec)
    verts_before = r_before["bodies"]["body_ex1"]["mesh"]["vertices"]

    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 2.0,
    })
    r_after = build(spec)
    verts_after = r_after["bodies"]["body_ex1"]["mesh"]["vertices"]

    assert len(verts_after) > len(verts_before)


# ---------------------------------------------------------------------------
# Chamfer tests
# ---------------------------------------------------------------------------


def test_chamfer_single_edge():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": 1.0,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_chamfer_multiple_edges():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0", "?body_ex1:edge:1"],
        "distance": 1.0,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_chamfer_distance_zero_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": 0,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "exception"
    assert "distance must be positive" in r["result"]["chamfer1"].get("exception", "")


def test_chamfer_negative_distance_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": -1,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "exception"
    assert "distance must be positive" in r["result"]["chamfer1"].get("exception", "")


def test_chamfer_empty_edges_errors():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": [],
        "distance": 1.0,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "exception"
    assert "requires at least one edge" in r["result"]["chamfer1"].get("exception", "")


def test_chamfer_chain_after_extrude():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": 1.0,
    })
    r = build(spec)
    assert r["result"]["chamfer1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_chamfer_updates_body():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    r_before = build(spec)
    verts_before = r_before["bodies"]["body_ex1"]["mesh"]["vertices"]

    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": 2.0,
    })
    r_after = build(spec)
    verts_after = r_after["bodies"]["body_ex1"]["mesh"]["vertices"]

    assert len(verts_after) > len(verts_before)


# ---------------------------------------------------------------------------
# Chain tests
# ---------------------------------------------------------------------------


def test_fillet_then_chamfer():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 1.0,
    })
    spec["features"].append({
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:1"],
        "distance": 0.5,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok"
    assert r["result"]["chamfer1"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_multiple_fillet_features():
    from oversolved.builder import build
    from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet 1",
        "edges": ["?body_ex1:edge:0"],
        "radius": 1.0,
    })
    spec["features"].append({
        "id": "fillet2",
        "kind": "fillet",
        "label": "Fillet 2",
        "edges": ["?body_ex1:edge:1"],
        "radius": 0.5,
    })
    r = build(spec)
    assert r["result"]["fillet1"]["status"] == "ok"
    assert r["result"]["fillet2"]["status"] == "ok"
    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)
