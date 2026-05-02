"""Tests for document clone feature."""

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
def app(tmp_path, monkeypatch):
    """Create a test Flask app with a file-based SQLite database."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
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
    """Create an unauthenticated test client."""
    return app.test_client()


@pytest.fixture
def authed_client(app):
    """Create a test client logged in as admin."""
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


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
        assert doc_store.has_permission(uuid, owner_id, "view") is True
        assert doc_store.has_permission(uuid, owner_id, "edit") is True

    def test_other_user_no_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)
        assert doc_store.has_permission(uuid, other_id, "view") is False

    def test_nonexistent_document(self, doc_store, user_store):
        user_id = user_store.create("user", "hash")
        assert doc_store.has_permission("no-such-uuid", user_id, "view") is False


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
        import sqlite3
        from werkzeug.security import generate_password_hash
        db_path = app.config["DB_PATH"]
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                ("user2", generate_password_hash("pass2"), 0),
            )
            conn.commit()

        client2 = app.test_client()
        login_resp = client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2"}),
            content_type="application/json",
        )
        assert login_resp.status_code == 200

        response = client2.post(f"/api/documents/{uuid}/clone")
        assert response.status_code == 403
