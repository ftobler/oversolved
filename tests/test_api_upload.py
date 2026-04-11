"""Tests for POST /api/upload route."""

import os
import re
import pytest

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.IFSelect import IFSelect_RetDone

from oversolved.app import create_app, UPLOAD_DIR


@pytest.fixture
def app(tmp_path):
    db_path = str(tmp_path / "test.db")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": db_path,
        }
    )
    test_app.config["TESTING"] = True
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


def test_missing_file_field(client):
    """1. missing file field - POST /api/upload with no file returns 400."""
    response = client.post("/api/upload")
    assert response.status_code == 400
    data = response.get_json()
    assert "error" in data


def test_wrong_extension(client):
    """2. wrong extension - POST .txt file returns 400."""
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
        f.write("hello")
        tmp_path = f.name
    try:
        with open(tmp_path, "rb") as f:
            response = client.post("/api/upload", data={"file": (f, "test.txt")})
        assert response.status_code == 400
        data = response.get_json()
        assert "error" in data
    finally:
        os.unlink(tmp_path)


def test_upload_step_file(client, step_file):
    """3. upload step file - POST real STEP file; returns 200 with file_id ending in .step."""
    with open(step_file, "rb") as f:
        response = client.post("/api/upload", data={"file": (f, "cube.step")})
    assert response.status_code == 200
    data = response.get_json()
    assert "file_id" in data
    assert data["file_id"].endswith(".step")


def test_file_id_is_uuid_like(client, step_file):
    """4. file_id is UUID-like - matches [0-9a-f-]{36}\\.step."""
    with open(step_file, "rb") as f:
        response = client.post("/api/upload", data={"file": (f, "cube.step")})
    data = response.get_json()
    file_id = data["file_id"]
    pattern = r"[0-9a-f\-]{36}\.step"
    assert re.match(pattern, file_id), (
        f"file_id {file_id!r} does not match UUID pattern"
    )


def test_file_persisted(client, step_file):
    """5. file persisted - after upload, file exists at oversolved/uploads/<file_id>."""
    with open(step_file, "rb") as f:
        response = client.post("/api/upload", data={"file": (f, "cube.step")})
    data = response.get_json()
    file_id = data["file_id"]
    filepath = os.path.join(UPLOAD_DIR, file_id)
    assert os.path.isfile(filepath), f"uploaded file not found at {filepath}"
