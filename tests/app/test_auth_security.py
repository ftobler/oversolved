"""Tests for unauthenticated endpoint access."""

import json


class TestUnauthenticatedAccess:
    """Tests for verifying unauthenticated requests are rejected."""

    def test_upload_rejected(self, client):
        """POST /api/upload without session should return 401."""
        response = client.post("/api/upload")
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
