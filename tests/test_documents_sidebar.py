"""Tests for documents sidebar feature (filters and server-side search)."""

import json
import pytest
from oversolved.app import create_app
from oversolved.db import (
    Database,
    SQLiteConnection,
    DocumentStore,
    UserStore,
)


def _make_db():
    conn = SQLiteConnection(":memory:")
    database = Database(conn)

    def migration_001(db: Database):
        db.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        db.execute("""
            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        db.execute("""
            CREATE TABLE documents (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        """)

    database.register_migration(1, "initial_schema", migration_001)

    def migration_002(db: Database):
        db.execute("ALTER TABLE documents ADD COLUMN preview_image BLOB")

    database.register_migration(2, "add_preview_image", migration_002)

    def migration_003(db: Database):
        db.execute("""
            CREATE TABLE document_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_uuid TEXT NOT NULL,
                shared_with_user_id INTEGER NULL,
                permission TEXT NOT NULL DEFAULT 'view',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE,
                FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(document_uuid, shared_with_user_id)
            )
        """)
        db.execute("ALTER TABLE documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")

    database.register_migration(3, "add_shares", migration_003)

    def migration_004(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")

    database.register_migration(4, "add_user_management_fields", migration_004)

    def migration_005(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")

    database.register_migration(5, "add_last_login", migration_005)

    def migration_006(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN email TEXT")
        db.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        db.execute("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
        db.execute("UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id_provider ON users(external_id, provider)")

    database.register_migration(6, "user_oauth_prep", migration_006)

    def migration_007(db: Database):
        db.execute(
            "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
        )

    database.register_migration(7, "user_sort_preference", migration_007)

    def migration_008(db: Database):
        pass

    database.register_migration(8, "organizations", migration_008)

    def migration_009(db: Database):
        pass

    database.register_migration(9, "documents_org_id", migration_009)

    def migration_010(db: Database):
        db.execute("ALTER TABLE documents ADD COLUMN deleted_at TEXT")
        db.execute("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)")

    database.register_migration(10, "document_trash", migration_010)

    def migration_011(db: Database):
        db.execute("""
            CREATE TABLE periodic_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_key TEXT UNIQUE NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT
            )
        """)

    database.register_migration(11, "periodic_tasks", migration_011)

    def migration_012(db: Database):
        db.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                handle TEXT UNIQUE NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle)
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_type, owner_id)
        """)

    database.register_migration(12, "accounts_table", migration_012)
    database.init()
    return database


@pytest.fixture
def db():
    database = _make_db()
    yield database
    database.close()


@pytest.fixture
def doc_store(db):
    return DocumentStore(db)


@pytest.fixture
def user_store(db):
    return UserStore(db)


@pytest.fixture
def app(tmp_path):
    db_path = str(tmp_path / "test.db")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        }
    )
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def authed_client(app):
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


@pytest.fixture
def authed_client2(app, authed_client):
    resp = authed_client.post(
        "/api/admin/users",
        data=json.dumps({"username": "user2", "password": "user2", "email": "user2@example.com", "is_admin": False}),
        content_type="application/json",
    )
    assert resp.status_code == 201
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "user2", "password": "user2"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


class TestDocumentStoreSidebar:
    """Tests for DocumentStore sidebar methods."""

    def test_list_public(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("PublicDoc", owner_id)
        doc_store.set_public(uuid, True)

        docs = doc_store.list_public()
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid
        assert docs[0]["name"] == "PublicDoc"
        assert docs[0]["is_owner"] is False
        assert docs[0]["owner_username"] == "owner"

    def test_list_public_empty_when_none(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        doc_store.create("PrivateDoc", owner_id)

        docs = doc_store.list_public()
        assert docs == []

    def test_list_public_includes_owner_username(self, doc_store, user_store):
        owner_id = user_store.create("alice", "hash")
        uuid = doc_store.create("Doc", owner_id)
        doc_store.set_public(uuid, True)

        docs = doc_store.list_public()
        assert docs[0]["owner_username"] == "alice"

    def test_list_shared_with(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("SharedDoc", owner_id)
        doc_store.share_document(uuid, other_id, "view")

        docs = doc_store.list_shared_with(other_id)
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid
        assert docs[0]["is_owner"] is False
        assert docs[0]["owner_username"] == "owner"

    def test_list_shared_with_empty(self, doc_store, user_store):
        other_id = user_store.create("other", "hash")
        docs = doc_store.list_shared_with(other_id)
        assert docs == []

    def test_list_shared_with_excludes_owned(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("OwnDoc", owner_id)
        doc_store.share_document(uuid, owner_id, "view")

        docs = doc_store.list_shared_with(owner_id)
        assert docs == []

    def test_search_by_name_owned(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        doc_store.create("AlphaDoc", owner_id)
        doc_store.create("BetaDoc", owner_id)

        docs = doc_store.search_by_name(owner_id, "alpha", filter_type="owned")
        assert len(docs) == 1
        assert docs[0]["name"] == "AlphaDoc"

    def test_search_by_name_shared(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("SharedDoc", owner_id)
        doc_store.share_document(uuid, other_id, "view")

        docs = doc_store.search_by_name(other_id, "shared", filter_type="shared")
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid

    def test_search_by_name_public(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("PublicDoc", owner_id)
        doc_store.set_public(uuid, True)

        docs = doc_store.search_by_name(999, "public", filter_type="public")
        assert len(docs) == 1
        assert docs[0]["uuid"] == uuid

    def test_search_by_name_case_insensitive(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        doc_store.create("MixedCase", owner_id)

        docs = doc_store.search_by_name(owner_id, "mixedcase", filter_type="owned")
        assert len(docs) == 1

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
