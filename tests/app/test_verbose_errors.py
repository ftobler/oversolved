"""Tests for verbose error message reduction."""

import json
import pytest
from oversolved.app import create_app
from PIL import Image
from io import BytesIO


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})


@pytest.fixture
def authed_client(app):
    """Return a test client that is already logged in as admin."""
    client = app.test_client()
    client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    return client


class TestVerboseUploadErrors:

    def test_upload_unsupported_extension_vague(self, authed_client):
        data = {"file": (BytesIO(b"test"), "malware.exe")}
        resp = authed_client.post("/api/upload", data=data)
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Unsupported file type"


class TestVerbosePreviewErrors:

    def test_preview_size_limit_vague(self, authed_client):
        # PUT no longer implicitly creates documents, so create one first; the
        # preview-size check is only reached on an existing, editable doc.
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "Doc"}),
                content_type="application/json",
            ).data
        )["uuid"]
        img = Image.new("RGB", (600, 600), color="red")
        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = __import__("base64").b64encode(buf.getvalue()).decode()
        resp = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "test", "preview_image": b64}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Invalid image"
