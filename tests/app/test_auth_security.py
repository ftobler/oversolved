"""Tests for unauthenticated endpoint access."""

import json
import pytest
from oversolved.app import create_app


@pytest.fixture
def app(pg_dsn, monkeypatch):
    """Create a test Flask app backed by a fresh PostgreSQL database."""
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
def client(app):
    """Create an unauthenticated test client."""
    return app.test_client()


class TestUnauthenticatedAccess:
    """Tests for verifying unauthenticated requests are rejected."""

    def test_upload_rejected(self, client):
        """POST /api/upload without session should return 401."""
        response = client.post("/api/upload")
        assert response.status_code == 401

    def test_export_step_rejected(self, client):
        """POST /api/export/step without session should return 401."""
        response = client.post(
            "/api/export/step",
            data=json.dumps({"features": []}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_export_stl_rejected(self, client):
        """POST /api/export/stl without session should return 401."""
        response = client.post(
            "/api/export/stl",
            data=json.dumps({"features": []}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_me_rejected(self, client):
        """GET /api/auth/me without session should return 401."""
        response = client.get("/api/auth/me")
        assert response.status_code == 401

    def test_documents_rejected(self, client):
        """GET /api/documents without session should return 401."""
        response = client.get("/api/documents")
        assert response.status_code == 401

    def test_create_document_rejected(self, client):
        """POST /api/documents without session should return 401."""
        response = client.post(
            "/api/documents",
            data=json.dumps({"name": "Test"}),
            content_type="application/json",
        )
        assert response.status_code == 401
