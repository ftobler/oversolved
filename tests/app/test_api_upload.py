"""Tests for POST /api/upload route."""

import os
import re
import pytest

pytest.importorskip("OCP.BRepPrimAPI")
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox  # noqa: E402
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs  # noqa: E402
from OCP.IFSelect import IFSelect_RetDone  # noqa: E402

from oversolved.app import create_app  # noqa: E402


@pytest.fixture
def app(pg_dsn, tmp_path, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    upload_dir = str(tmp_path / "uploads")
    monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", upload_dir)
    test_app = create_app(
        {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        }
    )
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def step_file(tmp_path):
    """Create a minimal STEP file for upload testing."""
    box = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    writer = STEPControl_Writer()
    writer.Transfer(box, STEPControl_AsIs)
    path = str(tmp_path / "upload_test.step")
    assert writer.Write(path) == IFSelect_RetDone
    return path


def test_upload_requires_auth(client):
    """0. unauthenticated POST /api/upload returns 401."""
    response = client.post("/api/upload")
    assert response.status_code == 401
    data = response.get_json()
    assert "error" in data


def test_missing_file_field(authed_client):
    """1. missing file field - POST /api/upload with no file returns 400."""
    response = authed_client.post("/api/upload")
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_wrong_extension(authed_client):
    """2. wrong extension - POST .txt file returns 400."""
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("hello")
        tmp_path = f.name
    try:
        with open(tmp_path, "rb") as f:
            response = authed_client.post("/api/upload", data={"file": (f, "test.txt")})
        assert response.status_code == 400
        data = response.get_json()
        assert "error" in data
    finally:
        os.unlink(tmp_path)


def test_upload_step_file(authed_client, step_file):
    """3. upload step file - POST real STEP file; returns 200 with file_id ending in .step."""
    with open(step_file, "rb") as f:
        response = authed_client.post("/api/upload", data={"file": (f, "cube.step")})
    assert response.status_code == 200
    data = response.get_json()
    assert "file_id" in data
    assert data["file_id"].endswith(".step")


def test_file_id_is_uuid_like(authed_client, step_file):
    """4. file_id is UUID-like - matches [0-9a-f-]{36}\\.step."""
    with open(step_file, "rb") as f:
        response = authed_client.post("/api/upload", data={"file": (f, "cube.step")})
    data = response.get_json()
    file_id = data["file_id"]
    pattern = r"[0-9a-f\-]{36}\.step"
    assert re.match(pattern, file_id), (
        f"file_id {file_id!r} does not match UUID pattern"
    )


def test_file_persisted(authed_client, step_file):
    """5. file persisted - after upload, file exists at upload_dir/<file_id>."""
    with open(step_file, "rb") as f:
        response = authed_client.post("/api/upload", data={"file": (f, "cube.step")})
    data = response.get_json()
    file_id = data["file_id"]
    upload_dir = authed_client.application.config["OVERSOLVED"].upload_dir
    filepath = os.path.join(upload_dir, file_id)
    assert os.path.isfile(filepath), f"uploaded file not found at {filepath}"
