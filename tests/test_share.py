"""Tests for document sharing feature."""

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
        db.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
        db.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        db.execute("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
        db.execute("UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id_provider ON users(external_id, provider)")

    database.register_migration(6, "user_oauth_prep", migration_006)

    def migration_007(db: Database):
        db.execute(
            "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
        )

    database.register_migration(7, "user_sort_preference", migration_007)
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
            "DB_PATH": db_path,
        }
    )
    test_app.config["TESTING"] = True
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


class TestDocumentStoreShares:
    """Tests for DocumentStore sharing methods."""

    def test_share_document(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "view")
        assert doc_store.has_permission(uuid, other_id, "view") is True
        assert doc_store.has_permission(uuid, other_id, "edit") is False

    def test_share_document_edit_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "edit")
        assert doc_store.has_permission(uuid, other_id, "view") is True
        assert doc_store.has_permission(uuid, other_id, "edit") is True

    def test_unshare_document(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "view")
        assert doc_store.has_permission(uuid, other_id, "view") is True

        doc_store.unshare_document(uuid, other_id)
        assert doc_store.has_permission(uuid, other_id, "view") is False

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
        assert doc_store.has_permission(uuid, other_id, "view") is True
        assert doc_store.has_permission(uuid, other_id, "edit") is False

        doc_store.set_public(uuid, False)
        assert doc_store.has_permission(uuid, other_id, "view") is False

    def test_get_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        assert doc_store.get_permission(uuid, owner_id) == "owner"
        assert doc_store.get_permission(uuid, other_id) is None

        doc_store.share_document(uuid, other_id, "edit")
        assert doc_store.get_permission(uuid, other_id) == "edit"

    def test_get_owner_username(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        uuid = doc_store.create("Doc", owner_id)
        assert doc_store.get_owner_username(uuid) == "owner"

    def test_list_owned_and_shared(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)
        doc_store.share_document(uuid, other_id, "view")

        owner_docs = doc_store.list_owned_and_shared(owner_id, include_shared=True)
        assert len(owner_docs) == 1
        assert owner_docs[0]["is_owner"] is True
        assert owner_docs[0]["owner_username"] == "owner"

        other_docs = doc_store.list_owned_and_shared(other_id, include_shared=True)
        assert len(other_docs) == 1
        assert other_docs[0]["is_owner"] is False
        assert other_docs[0]["owner_username"] == "owner"

    def test_list_owned_and_shared_exclude_shared(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)
        doc_store.share_document(uuid, other_id, "view")

        other_docs = doc_store.list_owned_and_shared(other_id, include_shared=False)
        assert len(other_docs) == 0


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
        import sqlite3
        from werkzeug.security import generate_password_hash
        db_path = app.config["DB_PATH"]
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                ("user2", generate_password_hash("pass2"), 0),
            )
            conn.commit()

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

    def test_create_share_non_owner(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Create another user and log in
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
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2"}),
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
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2"}),
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

        import sqlite3
        from werkzeug.security import generate_password_hash
        db_path = app.config["DB_PATH"]
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                ("user2", generate_password_hash("pass2"), 0),
            )
            conn.commit()

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

    def test_list_shares(self, app, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ShareDoc"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        import sqlite3
        from werkzeug.security import generate_password_hash
        db_path = app.config["DB_PATH"]
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                ("user2", generate_password_hash("pass2"), 0),
            )
            conn.commit()

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
        import sqlite3
        from werkzeug.security import generate_password_hash
        db_path = app.config["DB_PATH"]
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                ("user2", generate_password_hash("pass2"), 0),
            )
            conn.commit()

    def _login_client2(self, app):
        client2 = app.test_client()
        client2.post(
            "/api/auth/login",
            data=json.dumps({"username": "user2", "password": "pass2"}),
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
