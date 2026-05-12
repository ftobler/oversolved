"""Tests for POST /api/export/step route."""

import importlib
import json
import pytest

from oversolved.app import create_app
from solver_helpers import rect_sketch_spec, extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app(
        {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        }
    )
    return test_app


@pytest.fixture
def authed_client(app):
    c = app.test_client()
    resp = c.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    return c


def test_export_step_requires_auth(app):
    """0. unauthenticated POST /api/export/step returns 401."""
    client = app.test_client()
    response = client.post("/api/export/step", json={})
    assert response.status_code == 401
    data = response.get_json()
    assert "error" in data


def test_missing_features(authed_client):
    """1. missing features - POST /api/export/step without features returns 400."""
    response = authed_client.post("/api/export/step", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_empty_features(authed_client):
    """2. empty features - POST with empty features list returns 400."""
    response = authed_client.post("/api/export/step", json={"features": []})
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_no_bodies_to_export(authed_client):
    """3. no bodies to export - features with no bodies returns 400."""
    response = authed_client.post(
        "/api/export/step",
        json={"features": [{"id": "sk1", "kind": "sketch"}]},
    )
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_export_single_extrude(authed_client):
    """4. export single extrude - POST extrude feature; returns STEP file."""
    response = authed_client.post(
        "/api/export/step",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0),
                extrude_spec("sk1", "ex1", 2.0),
            ]
        },
    )
    if response.status_code != 200:
        print("ERROR:", response.get_json())
    assert response.status_code == 200
    assert "step" in response.content_type
    assert "attachment" in response.headers["Content-Disposition"]


def test_export_reads_back(authed_client):
    """5. export reads back - exported STEP can be imported and produces mesh."""
    pytest.importorskip("OCP.gp")
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from oversolved.kernel.geometry import solid_to_mesh

    response = authed_client.post(
        "/api/export/step",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0),
                extrude_spec("sk1", "ex1", 2.0),
            ]
        },
    )
    assert response.status_code == 200
    data = response.data
    import tempfile
    import os

    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
        f.write(data)
        tmp_path = f.name
    try:
        reader = STEPControl_Reader()
        status = reader.ReadFile(tmp_path)
        assert status == IFSelect_RetDone
        reader.TransferRoots()
        shape = reader.OneShape()
        assert not shape.IsNull()
        mesh = solid_to_mesh(shape)
        assert "vertices" in mesh
        assert len(mesh["vertices"]) > 0
    finally:
        os.unlink(tmp_path)


def test_export_multiple_bodies(authed_client):
    """6. export multiple bodies - both extrudes should be in exported STEP."""
    pytest.importorskip("OCP.gp")
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from oversolved.kernel.geometry import solid_to_mesh

    response = authed_client.post(
        "/api/export/step",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 2.0),
                rect_sketch_spec(w=3.0, h=3.0, sketch_id="sk2", plane="@builtin_plane_right"),
                extrude_spec("sk2", "ex2", 2.0),
            ]
        },
    )
    assert response.status_code == 200
    data = response.data
    import tempfile
    import os

    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
        f.write(data)
        tmp_path = f.name
    try:
        reader = STEPControl_Reader()
        status = reader.ReadFile(tmp_path)
        assert status == IFSelect_RetDone
        reader.TransferRoots()
        shape = reader.OneShape()
        assert not shape.IsNull()
        mesh = solid_to_mesh(shape)
        assert "vertices" in mesh
        xs = [v[0] for v in mesh["vertices"]]
        ys = [v[1] for v in mesh["vertices"]]
        zs = [v[2] for v in mesh["vertices"]]
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)
        z_range = max(zs) - min(zs)
        assert x_range >= 6.0, f"x_range {x_range} < 6.0 (first body width)"
        assert y_range >= 4.0, f"y_range {y_range} < 4.0 (first body height)"
        assert z_range >= 4.0, f"z_range {z_range} < 4.0 (combined height)"
    finally:
        os.unlink(tmp_path)


def test_export_specific_body_by_id(authed_client):
    """7. export specific body - body_id exports only the selected body."""
    response = authed_client.post(
        "/api/export/step",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 2.0),
                rect_sketch_spec(w=3.0, h=3.0, sketch_id="sk2", plane="@builtin_plane_right"),
                extrude_spec("sk2", "ex2", 2.0, operation="new"),
            ],
            "body_id": "body_ex2",
        },
    )
    assert response.status_code == 200
    assert "step" in response.content_type


def test_export_specific_body_invalid_id(authed_client):
    """8. invalid body_id - export returns 400."""
    response = authed_client.post(
        "/api/export/step",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0),
                extrude_spec("sk1", "ex1", 2.0),
            ],
            "body_id": "body_missing",
        },
    )
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data
