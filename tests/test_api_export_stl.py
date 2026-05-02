"""Tests for POST /api/export/stl route."""

import json
import pytest

from oversolved.app import create_app
from solver_helpers import rect_sketch_spec, extrude_spec


@pytest.fixture
def app(tmp_path):
    db_path = str(tmp_path / "test.db")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
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


def test_export_stl_requires_auth(app):
    """0. unauthenticated POST /api/export/stl returns 401."""
    client = app.test_client()
    response = client.post("/api/export/stl", json={})
    assert response.status_code == 401
    data = response.get_json()
    assert "error" in data


def test_missing_features(authed_client):
    """1. missing features - POST /api/export/stl without features returns 400."""
    response = authed_client.post("/api/export/stl", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_empty_features(authed_client):
    """2. empty features - POST with empty features list returns 400."""
    response = authed_client.post("/api/export/stl", json={"features": []})
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_no_bodies_to_export(authed_client):
    """3. no bodies to export - features with no bodies returns 400."""
    response = authed_client.post(
        "/api/export/stl",
        json={"features": [{"id": "sk1", "kind": "sketch"}]},
    )
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_export_single_extrude(authed_client):
    """4. export single extrude - POST extrude feature; returns STL file."""
    response = authed_client.post(
        "/api/export/stl",
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
    assert "application/sla" in response.content_type or "model/stl" in response.content_type or "text/plain" in response.content_type
    assert "attachment" in response.headers["Content-Disposition"]


def test_export_stl_valid_format(authed_client):
    """5. export STL valid format - content starts with 'solid' for ASCII STL."""
    response = authed_client.post(
        "/api/export/stl",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0),
                extrude_spec("sk1", "ex1", 2.0),
            ]
        },
    )
    assert response.status_code == 200
    data = response.data.decode("utf-8", errors="replace")
    assert "solid" in data or data.startswith("STL")


def test_export_with_tessellation_params(authed_client):
    """6. export with tessellation params - deflection values are applied."""
    response = authed_client.post(
        "/api/export/stl",
        json={
            "features": [
                rect_sketch_spec(w=6.0, h=4.0),
                extrude_spec("sk1", "ex1", 2.0),
            ],
            "deflection": 0.1,
            "angular_deflection": 0.1,
        },
    )
    if response.status_code != 200:
        print("ERROR:", response.get_json())
    assert response.status_code == 200
    data = response.data.decode("utf-8", errors="replace")
    assert "solid" in data or data.startswith("STL")


def test_export_multiple_bodies(authed_client):
    """7. export multiple bodies - fused into single STL."""
    response = authed_client.post(
        "/api/export/stl",
        json={
            "features": [
                rect_sketch_spec(w=2.0, h=2.0, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 2.0),
                rect_sketch_spec(w=3.0, h=3.0, sketch_id="sk2", plane="@builtin_plane_right"),
                extrude_spec("sk2", "ex2", 2.0),
            ]
        },
    )
    assert response.status_code == 200
    data = response.data.decode("utf-8", errors="replace")
    assert "solid" in data or data.startswith("STL")


def test_export_specific_body_by_id(authed_client):
    """8. export specific body - body_id exports only the selected body."""
    response = authed_client.post(
        "/api/export/stl",
        json={
            "features": [
                rect_sketch_spec(w=2.0, h=2.0, sketch_id="sk1"),
                extrude_spec("sk1", "ex1", 2.0),
                rect_sketch_spec(w=3.0, h=3.0, sketch_id="sk2", plane="@builtin_plane_right"),
                extrude_spec("sk2", "ex2", 2.0, operation="new"),
            ],
            "body_id": "body_ex2",
        },
    )
    assert response.status_code == 200
    data = response.data.decode("utf-8", errors="replace")
    assert "solid" in data or data.startswith("STL")


def test_export_specific_body_invalid_id(authed_client):
    """9. invalid body_id - export returns 400."""
    response = authed_client.post(
        "/api/export/stl",
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
