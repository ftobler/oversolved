"""Tests for GitHub-style organization model."""

import pytest
from oversolved.app import create_app
from oversolved.db import (
    Database,
    SQLiteConnection,
    OrgStore,
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

    def migration_008(db: Database):
        db.execute("""
            CREATE TABLE organizations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                description TEXT,
                is_personal INTEGER NOT NULL DEFAULT 0,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
            )
        """)
        db.execute("""
            CREATE TABLE organization_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                org_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(org_id, user_id)
            )
        """)

    database.register_migration(8, "organizations", migration_008)

    def migration_009(db: Database):
        db.execute("ALTER TABLE documents ADD COLUMN org_id INTEGER REFERENCES organizations(id)")

    database.register_migration(9, "documents_org_id", migration_009)
    database.init()
    return database


@pytest.fixture
def db():
    database = _make_db()
    yield database
    database.close()


@pytest.fixture
def org_store(db):
    return OrgStore(db)


@pytest.fixture
def user_store(db):
    return UserStore(db)


@pytest.fixture
def app(tmp_path):
    db_path = str(tmp_path / "test.db")
    test_app = create_app({"DB_TYPE": "sqlite", "DB_PATH": db_path})
    test_app.config["TESTING"] = True
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


def _login(client, username="admin", password="admin"):
    resp = client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200
    return resp


class TestOrgStoreUnit:
    """Unit tests for OrgStore."""

    def test_create_org(self, db, org_store, user_store):
        uid = user_store.create("alice", "hash", email="alice@x.com")
        org = org_store.create("alice", "Alice", uid, is_personal=True)
        assert org["slug"] == "alice"
        assert org["display_name"] == "Alice"
        assert org["is_personal"] is True
        assert org["owner_id"] == uid

    def test_owner_added_as_member_on_create(self, db, org_store, user_store):
        uid = user_store.create("bob", "hash", email="bob@x.com")
        org = org_store.create("bob", "Bob", uid, is_personal=True)
        role = org_store.get_member_role(org["id"], uid)
        assert role == "owner"

    def test_find_by_slug(self, db, org_store, user_store):
        uid = user_store.create("carol", "hash", email="carol@x.com")
        org_store.create("carol", "Carol", uid)
        found = org_store.find_by_slug("carol")
        assert found is not None
        assert found["slug"] == "carol"

    def test_find_by_slug_missing(self, db, org_store):
        assert org_store.find_by_slug("nonexistent") is None

    def test_list_for_user(self, db, org_store, user_store):
        uid = user_store.create("dave", "hash", email="dave@x.com")
        org1 = org_store.create("dave", "Dave", uid, is_personal=True)
        org2 = org_store.create("team-dave", "Team Dave", uid)
        orgs = org_store.list_for_user(uid)
        slugs = {o["slug"] for o in orgs}
        assert "dave" in slugs
        assert "team-dave" in slugs
        _ = org1, org2

    def test_add_member(self, db, org_store, user_store):
        owner = user_store.create("eve", "hash", email="eve@x.com")
        member = user_store.create("frank", "hash", email="frank@x.com")
        org = org_store.create("eve-team", "Eve Team", owner)
        org_store.add_member(org["id"], member, "write")
        role = org_store.get_member_role(org["id"], member)
        assert role == "write"

    def test_remove_member(self, db, org_store, user_store):
        owner = user_store.create("grace", "hash", email="grace@x.com")
        member = user_store.create("henry", "hash", email="henry@x.com")
        org = org_store.create("grace-team", "Grace Team", owner)
        org_store.add_member(org["id"], member, "read")
        org_store.remove_member(org["id"], member)
        role = org_store.get_member_role(org["id"], member)
        assert role is None

    def test_update_member_role(self, db, org_store, user_store):
        owner = user_store.create("iris", "hash", email="iris@x.com")
        member = user_store.create("jack", "hash", email="jack@x.com")
        org = org_store.create("iris-team", "Iris Team", owner)
        org_store.add_member(org["id"], member, "read")
        org_store.update_member_role(org["id"], member, "admin")
        assert org_store.get_member_role(org["id"], member) == "admin"

    def test_count_owners(self, db, org_store, user_store):
        owner1 = user_store.create("kate", "hash", email="kate@x.com")
        owner2 = user_store.create("leo", "hash", email="leo@x.com")
        org = org_store.create("duo-team", "Duo Team", owner1)
        org_store.add_member(org["id"], owner2, "owner")
        assert org_store.count_owners(org["id"]) == 2

    def test_delete_org(self, db, org_store, user_store):
        uid = user_store.create("mia", "hash", email="mia@x.com")
        org = org_store.create("mia-team", "Mia Team", uid)
        result = org_store.delete(org["id"])
        assert result is True
        assert org_store.find_by_slug("mia-team") is None

    def test_update_org(self, db, org_store, user_store):
        uid = user_store.create("noah", "hash", email="noah@x.com")
        org = org_store.create("noah-team", "Noah Team", uid)
        org_store.update(org["id"], display_name="Noah's Squad", description="A cool team")
        updated = org_store.find_by_id(org["id"])
        assert updated["display_name"] == "Noah's Squad"
        assert updated["description"] == "A cool team"

    def test_get_members(self, db, org_store, user_store):
        owner = user_store.create("olivia", "hash", email="olivia@x.com")
        member = user_store.create("peter", "hash", email="peter@x.com")
        org = org_store.create("olivia-team", "Olivia Team", owner)
        org_store.add_member(org["id"], member, "write")
        members = org_store.get_members(org["id"])
        roles = {m["user_id"]: m["role"] for m in members}
        assert roles[owner] == "owner"
        assert roles[member] == "write"


class TestOrgAPI:
    """Integration tests for org API endpoints."""

    def test_personal_org_created_on_user_creation(self, client):
        _login(client)
        resp = client.get("/api/users/me/orgs")
        assert resp.status_code == 200
        orgs = resp.get_json()["orgs"]
        personal = [o for o in orgs if o["is_personal"]]
        assert len(personal) == 1
        assert personal[0]["slug"] == "admin"

    def test_create_org(self, client):
        _login(client)
        resp = client.post("/api/orgs", json={
            "slug": "team-acme",
            "name": "Team ACME",
            "description": "Test org",
        })
        assert resp.status_code == 201
        data = resp.get_json()
        assert data["slug"] == "team-acme"
        assert data["is_personal"] is False

    def test_create_org_duplicate_slug(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "my-org", "name": "My Org"})
        resp = client.post("/api/orgs", json={"slug": "my-org", "name": "Another"})
        assert resp.status_code == 409

    def test_create_org_invalid_slug(self, client):
        _login(client)
        resp = client.post("/api/orgs", json={"slug": "My Org!", "name": "Bad"})
        assert resp.status_code == 400

    def test_get_org(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "my-team", "name": "My Team"})
        resp = client.get("/api/orgs/my-team")
        assert resp.status_code == 200
        assert resp.get_json()["slug"] == "my-team"

    def test_get_org_not_found(self, client):
        _login(client)
        resp = client.get("/api/orgs/nobody")
        assert resp.status_code == 404

    def test_update_org(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "update-me", "name": "Old Name"})
        resp = client.patch("/api/orgs/update-me", json={"name": "New Name"})
        assert resp.status_code == 200
        assert resp.get_json()["display_name"] == "New Name"

    def test_delete_org(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "deletable", "name": "To Delete"})
        resp = client.delete("/api/orgs/deletable")
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "deleted"

    def test_cannot_delete_personal_org(self, client):
        _login(client)
        resp = client.delete("/api/orgs/admin")
        assert resp.status_code == 403

    def test_add_member(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "collab", "name": "Collab"})
        client.post("/api/admin/users", json={
            "username": "alice", "email": "alice@x.com", "password": "pw",
        })
        resp = client.post("/api/orgs/collab/members", json={
            "username": "alice", "role": "write",
        })
        assert resp.status_code == 201
        assert resp.get_json()["role"] == "write"

    def test_remove_member(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "removeme", "name": "Remove"})
        client.post("/api/admin/users", json={
            "username": "bob2", "email": "bob2@x.com", "password": "pw",
        })
        add_resp = client.post("/api/orgs/removeme/members", json={
            "username": "bob2", "role": "read",
        })
        user_id = add_resp.get_json()["user_id"]
        resp = client.delete(f"/api/orgs/removeme/members/{user_id}")
        assert resp.status_code == 200

    def test_update_member_role(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "promote", "name": "Promote"})
        client.post("/api/admin/users", json={
            "username": "charlie2", "email": "charlie2@x.com", "password": "pw",
        })
        add_resp = client.post("/api/orgs/promote/members", json={
            "username": "charlie2", "role": "read",
        })
        user_id = add_resp.get_json()["user_id"]
        resp = client.patch(f"/api/orgs/promote/members/{user_id}", json={"role": "write"})
        assert resp.status_code == 200
        assert resp.get_json()["role"] == "write"

    def test_list_my_orgs(self, client):
        _login(client)
        client.post("/api/orgs", json={"slug": "listed-org", "name": "Listed"})
        resp = client.get("/api/users/me/orgs")
        assert resp.status_code == 200
        slugs = {o["slug"] for o in resp.get_json()["orgs"]}
        assert "admin" in slugs
        assert "listed-org" in slugs

    def test_create_document_in_org(self, client):
        _login(client)
        resp = client.post("/api/documents", json={
            "name": "org-doc",
            "org_slug": "admin",
        })
        assert resp.status_code == 201
        assert resp.get_json()["name"] == "org-doc"

    def test_create_document_in_nonexistent_org(self, client):
        _login(client)
        resp = client.post("/api/documents", json={
            "name": "bad-doc",
            "org_slug": "no-such-org",
        })
        assert resp.status_code == 404
