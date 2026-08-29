"""Tests for document clone feature."""

import json

from oversolved.blueprints import _permission_at_least

# DocumentStore.has_permission was removed as dead code; the production path is
# get_permission() + _permission_at_least, which this mirrors for the store tests.
def _has_perm(doc_store, uuid, user_id, level):
    return _permission_at_least(doc_store.get_permission(uuid, user_id), level)


class TestDocumentStoreClone:
    """Tests for DocumentStore.clone_document."""

    def test_clone_creates_new_document(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Original", owner_id)
        doc_store.store_content(uuid, "version: 1\n")

        new_uuid = doc_store.clone_document(uuid, owner_id, "Clone")
        assert new_uuid is not None
        assert new_uuid != uuid

        original = doc_store.retrieve(uuid)
        cloned = doc_store.retrieve(new_uuid)
        assert cloned["name"] == "Clone"
        assert cloned["content"] == original["content"]
        assert cloned["owner_id"] == owner_id

    def test_clone_copies_preview_image(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Original", owner_id)
        image_data = b"\x89PNG\r\n\x1a\n"
        doc_store.store_preview_image(uuid, image_data)

        new_uuid = doc_store.clone_document(uuid, owner_id, "Clone")
        cloned = doc_store.retrieve(new_uuid)
        assert cloned["preview_image"] == image_data

    def test_clone_with_different_owner(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Original", owner_id)
        doc_store.store_content(uuid, "content")

        new_uuid = doc_store.clone_document(uuid, other_id, "Clone")
        cloned = doc_store.retrieve(new_uuid)
        assert cloned["owner_id"] == other_id
        assert cloned["content"] == "content"

    def test_clone_invalid_source_returns_none(self, doc_store):
        result = doc_store.clone_document("no-such-uuid", 1, "Clone")
        assert result is None

    def test_clone_unique_uuid(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Original", owner_id)

        uuids = set()
        for i in range(5):
            new_uuid = doc_store.clone_document(uuid, owner_id, f"Clone {i}")
            assert new_uuid not in uuids
            uuids.add(new_uuid)


class TestDocumentStoreHasPermission:
    """Tests for DocumentStore.has_permission."""

    def test_owner_has_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Doc", owner_id)
        assert _has_perm(doc_store, uuid, owner_id, "view") is True
        assert _has_perm(doc_store, uuid, owner_id, "edit") is True

    def test_other_user_no_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)
        assert _has_perm(doc_store, uuid, other_id, "view") is False

    def test_nonexistent_document(self, doc_store, user_store):
        user_id = user_store.create("user", "hash")
        assert _has_perm(doc_store, "no-such-uuid", user_id, "view") is False


class TestCloneAPI:
    """Tests for the clone API endpoint."""

    def test_clone_creates_new_document(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TestDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 1\n"}),
            content_type="application/json",
        )

        response = authed_client.post(f"/api/documents/{uuid}/clone")
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data["name"] == "TestDoc (Clone)"
        assert "uuid" in data
        assert data["uuid"] != uuid

    def test_clone_copies_content(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ContentDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        content = "version: 1\nkind: part\n"

        authed_client.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": content}),
            content_type="application/json",
        )

        clone_resp = authed_client.post(f"/api/documents/{uuid}/clone")
        new_uuid = json.loads(clone_resp.data)["uuid"]

        doc_resp = authed_client.get(f"/api/documents/{new_uuid}")
        assert json.loads(doc_resp.data)["content"] == content

    def test_clone_nonexistent_document(self, authed_client):
        response = authed_client.post("/api/documents/no-such-uuid/clone")
        assert response.status_code == 404

    def test_clone_requires_auth(self, client):
        response = client.post("/api/documents/some-uuid/clone")
        assert response.status_code == 401

    def test_clone_unique_name(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "UniqueName"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        resp1 = authed_client.post(f"/api/documents/{uuid}/clone")
        assert json.loads(resp1.data)["name"] == "UniqueName (Clone)"

        resp2 = authed_client.post(f"/api/documents/{uuid}/clone")
        assert json.loads(resp2.data)["name"] == "UniqueName (Clone 1)"

        resp3 = authed_client.post(f"/api/documents/{uuid}/clone")
        assert json.loads(resp3.data)["name"] == "UniqueName (Clone 2)"

    def test_clone_uses_requested_name(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Bracket"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/clone",
            data=json.dumps({"name": "  Bracket v2  "}),
            content_type="application/json",
        )
        assert response.status_code == 201
        assert json.loads(response.data)["name"] == "Bracket v2"

    def test_clone_requested_name_is_not_uniquified(self, authed_client):
        """The user picked the name; taking it verbatim beats a surprise suffix."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Plate"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        body = json.dumps({"name": "Plate (Clone)"})
        resp1 = authed_client.post(f"/api/documents/{uuid}/clone", data=body, content_type="application/json")
        resp2 = authed_client.post(f"/api/documents/{uuid}/clone", data=body, content_type="application/json")
        assert json.loads(resp1.data)["name"] == "Plate (Clone)"
        assert json.loads(resp2.data)["name"] == "Plate (Clone)"

    def test_clone_blank_name_falls_back_to_suggestion(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Shaft"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/clone",
            data=json.dumps({"name": "   "}),
            content_type="application/json",
        )
        assert json.loads(response.data)["name"] == "Shaft (Clone)"

    def test_clone_forbidden_for_other_user(self, app, authed_client):
        """Non-owner cannot clone a document they don't have access to."""
        # Create document as admin
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "PrivateDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Create second user directly in app's database
        import psycopg2
        from werkzeug.security import generate_password_hash
        conn = psycopg2.connect(app.config["DB_DSN"])
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        conn.close()

        client2 = app.test_client()
        login_resp = client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2word"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 200

        response = client2.post(f"/api/documents/{uuid}/clone")
        assert response.status_code == 403
