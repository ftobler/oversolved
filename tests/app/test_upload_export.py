"""Route-logic tests for POST /api/upload that do not require OpenCascade.

The upload route never parses uploaded geometry: it validates the extension
and writes the bytes to disk. The richer round-trip tests in
``test_api_upload.py`` skip entirely when OCP is unavailable, leaving the save
path (file_id generation, persistence, JSON response) and the missing-field
branch uncovered. These tests exercise that logic with a plain byte payload.
"""

import os
import re
from io import BytesIO

import pytest

from oversolved.app import create_app


@pytest.fixture
def app(pg_dsn, tmp_path, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", str(tmp_path / "uploads"))
    return create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})


def test_missing_file_field_returns_400(authed_client):
    """POST with no file part hits the 'no file field' branch."""
    resp = authed_client.post("/api/upload")
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["ok"] is False
    assert data["error"] == "no file field"


@pytest.mark.parametrize("ext", [".step", ".stp", ".iges", ".igs"])
def test_upload_accepts_allowed_extensions(authed_client, ext):
    """A dummy payload with an allowed extension is stored and returns a file_id."""
    data = {"file": (BytesIO(b"not real geometry"), f"part{ext}")}
    resp = authed_client.post("/api/upload", data=data)
    assert resp.status_code == 200
    file_id = resp.get_json()["file_id"]
    assert file_id.endswith(ext)
    assert re.match(r"[0-9a-f\-]{36}" + re.escape(ext), file_id)


def test_uploaded_bytes_are_persisted(authed_client):
    """The saved file exists on disk and contains the uploaded bytes."""
    payload = b"ISO-10303-21; dummy step payload"
    data = {"file": (BytesIO(payload), "cube.step")}
    resp = authed_client.post("/api/upload", data=data)
    assert resp.status_code == 200
    file_id = resp.get_json()["file_id"]

    upload_dir = authed_client.application.config["OVERSOLVED"].upload_dir
    filepath = os.path.join(upload_dir, file_id)
    assert os.path.isfile(filepath)
    with open(filepath, "rb") as f:
        assert f.read() == payload


def test_upload_extension_is_lowercased(authed_client):
    """An uppercase extension is accepted and normalized to lowercase."""
    data = {"file": (BytesIO(b"data"), "PART.STEP")}
    resp = authed_client.post("/api/upload", data=data)
    assert resp.status_code == 200
    assert resp.get_json()["file_id"].endswith(".step")
