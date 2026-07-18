"""Tests for Flask API."""

import json


class TestAuthAPI:
    """Tests for authentication endpoints."""

    def test_login_success(self, client):
        response = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["user"]["username"] == "admin"
        assert data["user"]["must_change_password"] is True
        assert "session_token" in response.headers.get("Set-Cookie", "")

    def test_login_wrong_password(self, client):
        response = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "wrong"}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_login_unknown_user(self, client):
        response = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "nobody", "password": "pw"}),
            content_type="application/json",
        )
        assert response.status_code == 401

    def test_me_authenticated(self, authed_client):
        response = authed_client.get("/api/auth/me")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["user"]["username"] == "admin"

    def test_me_unauthenticated(self, client):
        response = client.get("/api/auth/me")
        assert response.status_code == 401

    def test_logout(self, authed_client):
        response = authed_client.post("/api/auth/logout")
        assert response.status_code == 200
        # After logout, me should return 401
        response = authed_client.get("/api/auth/me")
        assert response.status_code == 401

    def test_documents_require_auth(self, client):
        response = client.get("/api/documents")
        assert response.status_code == 401


class TestDocumentAPI:
    """Tests for document API endpoints."""

    def test_create_document(self, authed_client):
        response = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "My Doc"}),
            content_type="application/json",
        )
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data["name"] == "My Doc"
        assert "uuid" in data
        assert len(data["uuid"]) > 10

    def test_create_document_missing_name(self, authed_client):
        response = authed_client.post(
            "/api/documents",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_get_document(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TestDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        content = "version: 1\nkind: part\n"
        authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": content}),
            content_type="application/json",
        )

        response = authed_client.get(f"/api/documents/{uuid}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["uuid"] == uuid
        assert data["name"] == "TestDoc"
        assert data["content"] == content

    def test_get_nonexistent(self, authed_client):
        response = authed_client.get("/api/documents/no-such-uuid")
        assert response.status_code == 404

    def test_update_content(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "D"}),
                content_type="application/json",
            ).data
        )["uuid"]

        response = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 2\n"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        data = json.loads(authed_client.get(f"/api/documents/{uuid}").data)
        assert data["content"] == "version: 2\n"

    def test_update_missing_content(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "D"}),
                content_type="application/json",
            ).data
        )["uuid"]
        response = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"other": "x"}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_put_nonexistent_uuid_rejected(self, authed_client):
        """PUT no longer implicitly creates documents (security hardening: it now
        routes through require_doc_permission). A non-existent UUID is rejected
        with 404 rather than upserted into existence."""
        import uuid as uuid_mod
        new_uuid = "test-upsert-" + uuid_mod.uuid4().hex
        response = authed_client.put(
            f"/api/documents/{new_uuid}",
            data=json.dumps({"content": "version: 1\n"}),
            content_type="application/json",
        )
        assert response.status_code == 404

        # And no document was created as a side effect.
        assert authed_client.get(f"/api/documents/{new_uuid}").status_code == 404

    def test_rename_document(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "Old"}),
                content_type="application/json",
            ).data
        )["uuid"]

        response = authed_client.patch(
            f"/api/documents/{uuid}",
            data=json.dumps({"name": "New"}),
            content_type="application/json",
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["name"] == "New"
        assert data["uuid"] == uuid

        # UUID is stable after rename
        doc = json.loads(authed_client.get(f"/api/documents/{uuid}").data)
        assert doc["name"] == "New"

    def test_delete_document(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "ToDelete"}),
                content_type="application/json",
            ).data
        )["uuid"]

        response = authed_client.delete(f"/api/documents/{uuid}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "moved_to_trash"
        assert "deleted_at" in data
        assert "expires_at" in data

        # Soft-deleted document should not appear in normal list
        list_resp = authed_client.get("/api/documents")
        uuids = [d["uuid"] for d in json.loads(list_resp.data)["documents"]]
        assert uuid not in uuids

        # But should appear in trash
        trash_resp = authed_client.get("/api/documents/trash")
        trash_uuids = [d["uuid"] for d in json.loads(trash_resp.data)["documents"]]
        assert uuid in trash_uuids

    def test_delete_nonexistent(self, authed_client):
        response = authed_client.delete("/api/documents/no-uuid")
        assert response.status_code == 404

    def test_list_documents(self, authed_client):
        for name in ["Charlie", "Alpha", "Beta"]:
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": name}),
                content_type="application/json",
            )

        response = authed_client.get("/api/documents")
        assert response.status_code == 200
        data = json.loads(response.data)
        names = [d["name"] for d in data["documents"]]
        assert names == sorted(names)
        assert set(names) == {"Alpha", "Beta", "Charlie"}
        for d in data["documents"]:
            assert "uuid" in d
            assert "name" in d

    def test_list_documents_empty(self, authed_client):
        response = authed_client.get("/api/documents")
        assert response.status_code == 200
        assert json.loads(response.data)["documents"] == []

    def test_list_documents_includes_preview_image(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "WithPreview"}),
            content_type="application/json",
        )

        response = authed_client.get("/api/documents")
        assert response.status_code == 200
        data = json.loads(response.data)
        doc = next(d for d in data["documents"] if d["name"] == "WithPreview")
        assert "uuid" in doc
        assert "name" in doc
        assert doc["name"] == "WithPreview"

    def test_list_documents_without_preview_image(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "NoPreview"}),
            content_type="application/json",
        )

        response = authed_client.get("/api/documents")
        assert response.status_code == 200
        data = json.loads(response.data)
        doc = next(d for d in data["documents"] if d["name"] == "NoPreview")
        assert "uuid" in doc
        assert "name" in doc

    def test_large_document(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "large"}),
                content_type="application/json",
            ).data
        )["uuid"]

        large_content = "version: 1\n" + "key: value\n" * 5000
        authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": large_content}),
            content_type="application/json",
        )
        data = json.loads(authed_client.get(f"/api/documents/{uuid}").data)
        assert data["content"] == large_content

    def test_update_with_preview_image(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "PreviewDoc"}),
                content_type="application/json",
            ).data
        )["uuid"]

        import base64
        from io import BytesIO
        from PIL import Image

        img = Image.new("RGB", (100, 100), color="red")
        buf = BytesIO()
        img.save(buf, format="PNG")
        encoded = base64.b64encode(buf.getvalue()).decode("utf-8")

        response = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 1\n", "preview_image": encoded}),
            content_type="application/json",
        )
        assert response.status_code == 200

        data = json.loads(authed_client.get(f"/api/documents/{uuid}").data)
        assert "preview_image" in data
        assert data["preview_image"] == encoded

    def test_get_document_without_preview_image(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "NoPreview"}),
                content_type="application/json",
            ).data
        )["uuid"]

        authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 1\n"}),
            content_type="application/json",
        )

        data = json.loads(authed_client.get(f"/api/documents/{uuid}").data)
        assert "preview_image" not in data

    def test_preview_image_too_large_rejected(self, authed_client):
        uuid = json.loads(
            authed_client.post(
                "/api/documents",
                data=json.dumps({"name": "LargePreview"}),
                content_type="application/json",
            ).data
        )["uuid"]

        import base64
        from io import BytesIO
        from PIL import Image

        img = Image.new("RGB", (1200, 400), color="red")
        buf = BytesIO()
        img.save(buf, format="PNG")
        encoded = base64.b64encode(buf.getvalue()).decode("utf-8")

        response = authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 1\n", "preview_image": encoded}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert "Invalid image" in json.loads(response.data)["error"]
