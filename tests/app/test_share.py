"""Tests for document sharing feature."""

import json

from oversolved.blueprints import _permission_at_least

# DocumentStore.has_permission was removed as dead code; the production path is
# get_permission() + _permission_at_least, which this mirrors for the store tests.
def _has_perm(doc_store, uuid, user_id, level):
    return _permission_at_least(doc_store.get_permission(uuid, user_id), level)


class TestDocumentStoreShares:
    """Tests for DocumentStore sharing methods."""

    def test_share_document(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "view")
        assert _has_perm(doc_store, uuid, other_id, "view") is True
        assert _has_perm(doc_store, uuid, other_id, "edit") is False

    def test_share_document_edit_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "edit")
        assert _has_perm(doc_store, uuid, other_id, "view") is True
        assert _has_perm(doc_store, uuid, other_id, "edit") is True

    def test_unshare_document(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "view")
        assert _has_perm(doc_store, uuid, other_id, "view") is True

        doc_store.unshare_document(uuid, other_id)
        assert _has_perm(doc_store, uuid, other_id, "view") is False

    def test_get_shares(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "edit")
        shares = doc_store.get_shares(uuid)
        assert len(shares) == 1
        assert shares[0]["username"] == "other"
        assert shares[0]["permission"] == "edit"

    def test_set_public(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert _has_perm(doc_store, uuid, other_id, "view") is True
        assert _has_perm(doc_store, uuid, other_id, "edit") is False

        doc_store.set_public(uuid, False)
        assert _has_perm(doc_store, uuid, other_id, "view") is False

    def test_get_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        assert doc_store.get_permission(uuid, owner_id) == "owner"
        assert doc_store.get_permission(uuid, other_id) is None

        doc_store.share_document(uuid, other_id, "edit")
        assert doc_store.get_permission(uuid, other_id) == "edit"


class TestShareAPI:
    """Tests for share API endpoints."""

    def test_create_share(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Create another user
        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )
        assert response.status_code == 201
        assert json.loads(response.data)["status"] == "shared"

    def test_create_share_invalid_user(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "nonexistent"}),
            content_type="application/json",
        )
        assert response.status_code == 404

    def test_create_share_empty_username_rejected(self, app, authed_client):
        """An explicit empty username must 400, not fall through to publish."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": ""}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "BAD_REQUEST"

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is False

    def test_create_share_whitespace_username_rejected(self, app, authed_client):
        """Whitespace-only counts as empty and must not publish the document."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "   "}),
            content_type="application/json",
        )
        assert response.status_code == 400

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is False

    def test_create_share_absent_username_still_publishes(self, app, authed_client):
        """Omitting the username key remains a public link-share request."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert response.status_code == 201

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is True

    def test_create_share_non_owner(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Create another user and log in
        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

        client2 = app.test_client()
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2word"}),
            content_type="application/json",
        )

        response = client2.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "admin"}),
            content_type="application/json",
        )
        assert response.status_code == 403

    def test_public_link(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "PublicDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert response.status_code == 201

        # Create another user and check access
        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

        client2 = app.test_client()
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2word"}),
            content_type="application/json",
        )

        doc_resp = client2.get(f"/api/documents/{uuid}")
        assert doc_resp.status_code == 200
        data = json.loads(doc_resp.data)
        assert data["permission"] == "view"

    def test_remove_share(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2"}),
            content_type="application/json",
        )

        response = authed_client.delete(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_remove_share_blank_username_rejected(self, app, authed_client):
        """A present but blank username must 400 instead of unpublishing."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )

        response = authed_client.delete(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": ""}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "BAD_REQUEST"

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is True

    def test_remove_share_null_username_rejected(self, app, authed_client):
        """A null username must 400 and leave the document public."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )

        response = authed_client.delete(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": None}),
            content_type="application/json",
        )
        assert response.status_code == 400
        assert json.loads(response.data)["code"] == "BAD_REQUEST"

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is True

    def test_remove_share_absent_username_still_unpublishes(self, app, authed_client):
        """Omitting the username key as owner remains an unpublish request."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )

        response = authed_client.delete(
            f"/api/documents/{uuid}/share",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert response.status_code == 200

        doc_resp = authed_client.get(f"/api/documents/{uuid}")
        assert json.loads(doc_resp.data)["is_public"] is False

    def test_list_shares(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "edit"}),
            content_type="application/json",
        )

        response = authed_client.get(f"/api/documents/{uuid}/shares")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert len(data["shares"]) == 1
        assert data["shares"][0]["username"] == "user2"
        assert data["shares"][0]["permission"] == "edit"


class TestAccessControl:
    """Tests for document access control with sharing."""

    def _create_user2(self, app):
        import psycopg2
        from werkzeug.security import generate_password_hash
        _conn = psycopg2.connect(app.config["DB_DSN"])
        _conn.autocommit = True
        with _conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (%s, %s, %s)",
                ("user2", generate_password_hash("pass2word"), 0),
            )
        _conn.close()

    def _login_client2(self, app):
        client2 = app.test_client()
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2word"}),
            content_type="application/json",
        )
        return client2

    def test_owner_can_access(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.get(f"/api/documents/{uuid}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["permission"] == "owner"

    def test_shared_user_view_can_access(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        client2 = self._login_client2(app)
        response = client2.get(f"/api/documents/{uuid}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["permission"] == "view"

    def test_shared_user_edit_can_save(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "edit"}),
            content_type="application/json",
        )

        client2 = self._login_client2(app)
        response = client2.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 2\n"}),
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_shared_user_view_cannot_save(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        client2 = self._login_client2(app)
        response = client2.put(
            f"/api/documents/{uuid}",
            data=json.dumps({"content": "version: 2\n"}),
            content_type="application/json",
        )
        assert response.status_code == 403

    def test_unshared_user_cannot_access(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        client2 = self._login_client2(app)
        response = client2.get(f"/api/documents/{uuid}")
        assert response.status_code == 403

    def test_list_includes_shared_docs(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        client2 = self._login_client2(app)
        response = client2.get("/api/documents")
        assert response.status_code == 200
        data = json.loads(response.data)
        doc = next((d for d in data["documents"] if d["uuid"] == uuid), None)
        assert doc is not None
        assert doc["is_owner"] is False
        assert doc["owner_username"] == "admin"

    def test_list_exclude_shared_docs(self, app, authed_client):
        self._create_user2(app)
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Doc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        client2 = self._login_client2(app)
        response = client2.get("/api/documents?include_shared=false")
        assert response.status_code == 200
        data = json.loads(response.data)
        doc = next((d for d in data["documents"] if d["uuid"] == uuid), None)
        assert doc is None
