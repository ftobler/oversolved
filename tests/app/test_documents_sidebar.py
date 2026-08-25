"""Tests for documents sidebar feature (filters and server-side search)."""

import json
import pytest


@pytest.fixture
def authed_client2(app, authed_client):
    resp = authed_client.post(
        "/api/admin/users",
        data=json.dumps({"username": "user2", "password": "user2pass",
                         "email": "user2@example.com", "is_admin": False}),
        content_type="application/json",
    )
    assert resp.status_code == 201
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "user2", "password": "user2pass"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


class TestDocumentStoreSidebar:
    """Tests for DocumentStore sidebar methods."""

    def test_list_by_filter_owned(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        own_uuid = doc_store.create("OwnDoc", owner_id)
        shared_uuid = doc_store.create("SharedDoc", owner_id)
        doc_store.share_document(shared_uuid, other_id, "view")

        docs = doc_store.list_by_filter(owner_id, filter_type="owned")
        assert len(docs) == 2
        assert {d["uuid"] for d in docs} == {own_uuid, shared_uuid}

    def test_list_by_filter_shared(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("SharedDoc", owner_id)
        doc_store.share_document(uuid, other_id, "view")

        docs = doc_store.list_by_filter(other_id, filter_type="shared")
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid

    def test_list_by_filter_public(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("PublicDoc", owner_id)
        doc_store.set_public(uuid, True)

        docs = doc_store.list_by_filter(999, filter_type="public")
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid

    def test_list_by_filter_all(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        own_uuid = doc_store.create("OwnDoc", owner_id)
        shared_uuid = doc_store.create("SharedDoc", owner_id)
        public_uuid = doc_store.create("PublicDoc", owner_id)
        doc_store.share_document(shared_uuid, other_id, "view")
        doc_store.set_public(public_uuid, True)

        docs = doc_store.list_by_filter(other_id, filter_type="all")
        uuids = {d["uuid"] for d in docs}
        assert shared_uuid in uuids
        assert public_uuid in uuids
        assert own_uuid not in uuids

    def test_list_by_filter_with_search(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        doc_store.create("AlphaDoc", owner_id)
        doc_store.create("BetaDoc", owner_id)

        docs = doc_store.list_by_filter(owner_id, filter_type="owned", search="alpha")
        assert len(docs) == 1
        assert docs[0]["name"] == "AlphaDoc"

    def test_list_by_filter_returns_owner_info(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        doc_store.create("Doc", owner_id)

        docs = doc_store.list_by_filter(owner_id, filter_type="owned")
        assert len(docs) == 1
        assert docs[0]["is_owner"] is True
        assert docs[0]["owner_username"] == "owner"

    def test_list_by_filter_rows_carry_no_preview_blob(self, doc_store, user_store):
        """Listing rows must not select the preview blob at all.

        The list endpoint never served previews (they are fetched per
        document), so selecting the column only dragged every stored image
        through memory on each sidebar render.
        """
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Doc", owner_id)
        doc_store.store_preview_image(uuid, b"fake-png-bytes")

        docs = doc_store.list_by_filter(owner_id, filter_type="owned")
        assert len(docs) == 1
        assert "preview_image" not in docs[0]


class TestDocumentsAPISidebar:
    """Tests for documents API sidebar endpoints."""

    def test_filter_owned_default(self, authed_client):
        resp = authed_client.get("/api/documents")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert "documents" in data

    def test_filter_shared(self, authed_client, authed_client2):
        # Admin creates a doc and shares it with user2
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "SharedWithUser2"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        # user2 sees it under shared
        resp = authed_client2.get("/api/documents?filter=shared")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        names = [d["name"] for d in data["documents"]]
        assert "SharedWithUser2" in names

    def test_filter_public(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "PublicDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"permission": "view"}),
            content_type="application/json",
        )

        resp = authed_client.get("/api/documents?filter=public")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        names = [d["name"] for d in data["documents"]]
        assert "PublicDoc" in names

    def test_filter_all(self, authed_client, authed_client2):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "MyDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        resp = authed_client2.get("/api/documents?filter=all")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        names = [d["name"] for d in data["documents"]]
        assert "MyDoc" in names

    def test_search_param(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "SearchableDoc"}),
            content_type="application/json",
        )

        resp = authed_client.get("/api/documents?search=searchable")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["documents"]) == 1
        assert data["documents"][0]["name"] == "SearchableDoc"

    def test_search_no_results(self, authed_client):
        resp = authed_client.get("/api/documents?search=xyznonexistent")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["documents"] == []

    def test_search_with_filter(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "AlphaDoc"}),
            content_type="application/json",
        )
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "BetaDoc"}),
            content_type="application/json",
        )

        resp = authed_client.get("/api/documents?filter=owned&search=alpha")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["documents"]) == 1
        assert data["documents"][0]["name"] == "AlphaDoc"

    def test_backward_compat_include_shared_true(self, authed_client, authed_client2):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "SharedCompat"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        resp = authed_client2.get("/api/documents?include_shared=true")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        names = [d["name"] for d in data["documents"]]
        assert "SharedCompat" in names

    def test_backward_compat_include_shared_false(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "PrivateCompat"}),
            content_type="application/json",
        )

        resp = authed_client.get("/api/documents?include_shared=false")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        names = [d["name"] for d in data["documents"]]
        assert "PrivateCompat" in names

    def test_response_has_is_owner(self, authed_client):
        authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "OwnDoc"}),
            content_type="application/json",
        )

        resp = authed_client.get("/api/documents?filter=owned")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["documents"]) == 1
        assert data["documents"][0]["is_owner"] is True

    def test_response_has_owner_username(self, authed_client, authed_client2):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "SharedForOwner"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]
        authed_client.post(
            f"/api/documents/{uuid}/share",
            data=json.dumps({"username": "user2", "permission": "view"}),
            content_type="application/json",
        )

        resp = authed_client2.get("/api/documents?filter=shared")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert len(data["documents"]) == 1
        assert data["documents"][0]["owner_username"] == "admin"
