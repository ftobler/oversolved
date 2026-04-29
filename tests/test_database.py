"""Tests for database layer."""

import pytest
from oversolved.db import (
    Database,
    SQLiteConnection,
    DocumentStore,
    UserStore,
    SessionStore,
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
        """Add email, nickname, OAuth fields to users table."""
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
def user_store(db):
    return UserStore(db)


@pytest.fixture
def session_store(db):
    return SessionStore(db)


@pytest.fixture
def doc_store(db):
    return DocumentStore(db)


@pytest.fixture
def user_id(user_store):
    return user_store.create("testuser", "hashed_pw")


class TestSQLiteConnection:
    """Tests for SQLite connection."""

    def test_execute_query(self):
        conn = SQLiteConnection(":memory:")
        cursor = conn.execute("SELECT 1 as num")
        row = cursor.fetchone()
        assert row[0] == 1
        conn.close()

    def test_commit_rollback(self):
        conn = SQLiteConnection(":memory:")
        conn.execute("CREATE TABLE test (id INTEGER)")
        conn.commit()

        conn.execute("INSERT INTO test VALUES (1)")
        conn.commit()

        cursor = conn.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

        conn.execute("DELETE FROM test")
        conn.rollback()

        cursor = conn.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

        conn.close()


class TestDatabase:
    """Tests for Database class."""

    def test_init_creates_schema_version_table(self, db):
        cursor = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
        )
        assert cursor.fetchone() is not None

    def test_migration_runs_once(self, db):
        call_count = 0

        def test_migration(database: Database):
            nonlocal call_count
            call_count += 1
            database.execute("CREATE TABLE test_once (id INTEGER)")

        db.register_migration(10, "test_migration", test_migration)
        db.init()
        assert call_count == 1

        db.init()
        assert call_count == 1

    def test_transaction_commits(self, db):
        db.execute("CREATE TABLE test (id INTEGER)")
        db.commit()

        with db.transaction():
            db.execute("INSERT INTO test VALUES (1)")

        cursor = db.execute("SELECT * FROM test")
        assert cursor.fetchone()[0] == 1

    def test_transaction_rollback_on_error(self, db):
        db.execute("CREATE TABLE test (id INTEGER)")
        db.commit()

        try:
            with db.transaction():
                db.execute("INSERT INTO test VALUES (1)")
                raise RuntimeError("Test error")
        except RuntimeError:
            pass

        cursor = db.execute("SELECT COUNT(*) FROM test")
        assert cursor.fetchone()[0] == 0


class TestUserStore:
    """Tests for UserStore."""

    def test_create_and_find(self, user_store):
        uid = user_store.create("alice", "hash123")
        assert isinstance(uid, int)

        user = user_store.find_by_username("alice")
        assert user is not None
        assert user["username"] == "alice"
        assert user["password_hash"] == "hash123"
        assert user["must_change_password"] is False

    def test_create_with_must_change_password(self, user_store):
        user_store.create("bob", "hash", must_change_password=True)
        user = user_store.find_by_username("bob")
        assert user["must_change_password"] is True

    def test_find_by_id(self, user_store):
        uid = user_store.create("charlie", "hash")
        user = user_store.find_by_id(uid)
        assert user is not None
        assert user["username"] == "charlie"

    def test_find_nonexistent(self, user_store):
        assert user_store.find_by_username("nobody") is None
        assert user_store.find_by_id(9999) is None

    def test_update_user(self, user_store):
        uid = user_store.create("updatable", "hash")
        success = user_store.update(uid, username="updated")
        assert success is True
        user = user_store.find_by_id(uid)
        assert user["username"] == "updated"

    def test_update_user_password(self, user_store):
        uid = user_store.create("pwuser", "hash")
        success = user_store.update(uid, password_hash="newhash")
        assert success is True
        user = user_store.find_by_username("pwuser")
        assert user["password_hash"] == "newhash"

    def test_update_nonexistent_user(self, user_store):
        success = user_store.update(9999, username="ghost")
        assert success is False

    def test_delete_user(self, user_store):
        uid = user_store.create("deletable", "hash")
        success = user_store.delete(uid)
        assert success is True
        assert user_store.find_by_id(uid) is None

    def test_delete_nonexistent_user(self, user_store):
        success = user_store.delete(9999)
        assert success is False

    def test_list_all_users(self, user_store):
        user_store.create("alpha", "hash")
        user_store.create("beta", "hash")
        users = user_store.list_all()
        assert len(users) >= 2
        usernames = [u["username"] for u in users]
        assert "alpha" in usernames
        assert "beta" in usernames
        for user in users:
            assert "password_hash" not in user
            assert "is_admin" in user
            assert "is_active" in user

    def test_set_active(self, user_store):
        uid = user_store.create("activeuser", "hash")
        user_store.set_active(uid, False)
        user = user_store.find_by_id(uid)
        assert user["is_active"] is False
        user_store.set_active(uid, True)
        user = user_store.find_by_id(uid)
        assert user["is_active"] is True

    def test_set_admin(self, user_store):
        uid = user_store.create("admincandidate", "hash")
        user_store.set_admin(uid, True)
        user = user_store.find_by_id(uid)
        assert user["is_admin"] is True
        user_store.set_admin(uid, False)
        user = user_store.find_by_id(uid)
        assert user["is_admin"] is False

    def test_change_password(self, user_store):
        uid = user_store.create("pwchanger", "hash")
        user_store.change_password(uid, "newhash")
        user = user_store.find_by_username("pwchanger")
        assert user["password_hash"] == "newhash"


class TestSessionStore:
    """Tests for SessionStore."""

    def test_create_and_find(self, session_store, user_id):
        token = session_store.create(user_id)
        assert isinstance(token, str)
        assert len(token) > 20

        session = session_store.find(token)
        assert session is not None
        assert session["user_id"] == user_id

    def test_find_nonexistent(self, session_store):
        assert session_store.find("no-such-token") is None

    def test_delete(self, session_store, user_id):
        token = session_store.create(user_id)
        session_store.delete(token)
        assert session_store.find(token) is None


class TestDocumentStore:
    """Tests for DocumentStore."""

    def test_create_returns_uuid(self, doc_store, user_id):
        uuid = doc_store.create("My Doc", user_id)
        assert isinstance(uuid, str)
        assert len(uuid) > 10

    def test_retrieve(self, doc_store, user_id):
        uuid = doc_store.create("Test", user_id)
        doc_store.store_content(uuid, "version: 1\n")

        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert doc["uuid"] == uuid
        assert doc["name"] == "Test"
        assert doc["content"] == "version: 1\n"
        assert doc["owner_id"] == user_id

    def test_retrieve_nonexistent(self, doc_store):
        assert doc_store.retrieve("no-such-uuid") is None

    def test_store_content_updates(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        doc_store.store_content(uuid, "v1")
        doc_store.store_content(uuid, "v2")
        assert doc_store.retrieve(uuid)["content"] == "v2"

    def test_rename(self, doc_store, user_id):
        uuid = doc_store.create("Old Name", user_id)
        result = doc_store.rename(uuid, "New Name")
        assert result is True
        assert doc_store.retrieve(uuid)["name"] == "New Name"

    def test_rename_nonexistent(self, doc_store):
        assert doc_store.rename("no-uuid", "Name") is False

    def test_delete(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        assert doc_store.delete(uuid) is True
        assert doc_store.retrieve(uuid) is None

    def test_delete_nonexistent(self, doc_store):
        assert doc_store.delete("no-uuid") is False

    def test_list_by_owner(self, doc_store, user_id):
        doc_store.create("Beta", user_id)
        doc_store.create("Alpha", user_id)
        docs = doc_store.list_by_owner(user_id)
        assert len(docs) == 2
        assert docs[0]["name"] == "Alpha"
        assert docs[1]["name"] == "Beta"
        for d in docs:
            assert "uuid" in d
            assert "name" in d
            assert "preview_image" in d

    def test_list_by_owner_empty(self, doc_store, user_id):
        assert doc_store.list_by_owner(user_id) == []

    def test_list_by_owner_isolation(self, doc_store, user_store):
        uid1 = user_store.create("user1", "h")
        uid2 = user_store.create("user2", "h")
        doc_store.create("Doc A", uid1)
        doc_store.create("Doc B", uid2)
        assert len(doc_store.list_by_owner(uid1)) == 1
        assert len(doc_store.list_by_owner(uid2)) == 1

    def test_store_and_retrieve_preview_image(self, doc_store, user_id):
        uuid = doc_store.create("Img Doc", user_id)
        image_data = b"\x89PNG\r\n\x1a\n"  # PNG magic header bytes
        doc_store.store_preview_image(uuid, image_data)

        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert doc["preview_image"] == image_data

    def test_preview_image_is_none_by_default(self, doc_store, user_id):
        uuid = doc_store.create("No Img", user_id)
        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert doc["preview_image"] is None

    def test_store_preview_image_overwrites(self, doc_store, user_id):
        uuid = doc_store.create("Time Doc", user_id)
        doc_store.store_preview_image(uuid, b"first_image")

        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert doc["preview_image"] == b"first_image"

        doc_store.store_preview_image(uuid, b"second_image")

        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert doc["preview_image"] == b"second_image"


class TestUserStoreOAuth:
    """Tests for UserStore OAuth preparation features."""

    def test_create_with_email(self, user_store):
        uid = user_store.create("user1", "hash", email="user1@example.com")
        user = user_store.find_by_id(uid)
        assert user is not None
        assert user["email"] == "user1@example.com"

    def test_create_with_nickname(self, user_store):
        uid = user_store.create("user2", "hash", nickname="user_twO")
        user = user_store.find_by_id(uid)
        assert user is not None
        assert user["nickname"] == "user_twO"

    def test_create_with_all_fields(self, user_store):
        uid = user_store.create(
            "user3", "hash", email="user3@example.com", nickname="user3_nick",
            external_id="ext_123", provider="google", provider_data='{"name": "User"}'
        )
        user = user_store.find_by_id(uid)
        assert user is not None
        assert user["email"] == "user3@example.com"
        assert user["nickname"] == "user3_nick"
        assert user["external_id"] == "ext_123"
        assert user["provider"] == "google"
        assert user["provider_data"] == '{"name": "User"}'

    def test_find_by_email(self, user_store):
        user_store.create("user4", "hash", email="user4@example.com")
        user = user_store.find_by_email("user4@example.com")
        assert user is not None
        assert user["username"] == "user4"

    def test_find_by_email_case_insensitive(self, user_store):
        user_store.create("user5", "hash", email="User5@Example.COM")
        user = user_store.find_by_email("user5@example.com")
        assert user is not None
        assert user["username"] == "user5"

    def test_find_by_email_not_found(self, user_store):
        user = user_store.find_by_email("nonexistent@example.com")
        assert user is None

    def test_find_by_nickname(self, user_store):
        user_store.create("user6", "hash", nickname="nick6")
        user = user_store.find_by_nickname("nick6")
        assert user is not None
        assert user["username"] == "user6"

    def test_find_by_nickname_not_found(self, user_store):
        user = user_store.find_by_nickname("nonexistent")
        assert user is None

    def test_find_by_external_id(self, user_store):
        user_store.create("user7", "hash", external_id="ext_456", provider="github")
        user = user_store.find_by_external_id("ext_456", "github")
        assert user is not None
        assert user["username"] == "user7"

    def test_find_by_external_id_wrong_provider(self, user_store):
        user_store.create("user8", "hash", external_id="ext_789", provider="google")
        user = user_store.find_by_external_id("ext_789", "github")
        assert user is None

    def test_update_email(self, user_store, user_id):
        result = user_store.update(user_id, email="updated@example.com")
        assert result is True
        user = user_store.find_by_id(user_id)
        assert user["email"] == "updated@example.com"

    def test_update_nickname(self, user_store, user_id):
        result = user_store.update(user_id, nickname="new_nick")
        assert result is True
        user = user_store.find_by_id(user_id)
        assert user["nickname"] == "new_nick"

    def test_update_nickname_to_null(self, user_store, user_id):
        user_store.update(user_id, nickname="old_nick")
        result = user_store.update(user_id, nickname=None)
        assert result is True
        user = user_store.find_by_id(user_id)
        assert user["nickname"] is None

    def test_list_all_includes_new_fields(self, user_store):
        user_store.create("user9", "hash", email="user9@example.com", nickname="nick9")
        users = user_store.list_all()
        user = next(u for u in users if u["username"] == "user9")
        assert user["email"] == "user9@example.com"
        assert user["nickname"] == "nick9"

    def test_backfill_email_on_migration(self):
        """Test that existing users get backfilled email during migration."""
        conn = SQLiteConnection(":memory:")
        database = Database(conn)

        def migration_001(db):
            db.execute("""
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    must_change_password INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
        database.register_migration(1, "initial", migration_001)

        def migration_004(db):
            db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
            db.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
        database.register_migration(4, "add_user_management", migration_004)

        def migration_005(db):
            db.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")
        database.register_migration(5, "add_last_login", migration_005)

        def migration_006(db):
            db.execute("ALTER TABLE users ADD COLUMN email TEXT")
            db.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
            db.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
            db.execute("ALTER TABLE users ADD COLUMN provider TEXT")
            db.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
            db.execute("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
            db.execute("UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        database.register_migration(6, "oauth_prep", migration_006)

        def migration_007(db):
            db.execute(
                "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
            )
        database.register_migration(7, "user_sort_preference", migration_007)
        database.init()
        store = UserStore(database)
        uid = store.create("testuser", "hash", email="testuser@local.oversolved")
        user = store.find_by_id(uid)
        assert user["email"] == "testuser@local.oversolved"
        database.close()


class TestDocumentStorePublicAccess:
    """Tests for is_public as single source of truth."""

    def test_public_document_has_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner", "hash")
        other_id = user_store.create("other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert doc_store.has_permission(uuid, other_id, "view") is True

    def test_public_document_has_no_edit_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner2", "hash")
        other_id = user_store.create("other2", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert doc_store.has_permission(uuid, other_id, "edit") is False

    def test_public_document_get_permission(self, doc_store, user_store):
        owner_id = user_store.create("owner3", "hash")
        other_id = user_store.create("other3", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert doc_store.get_permission(uuid, other_id) == "view"

    def test_list_owned_and_shared_includes_public(self, doc_store, user_store):
        owner_id = user_store.create("owner4", "hash")
        other_id = user_store.create("other4", "hash")
        uuid = doc_store.create("PublicDoc", owner_id)

        doc_store.set_public(uuid, True)
        docs = doc_store.list_owned_and_shared(other_id, include_shared=True)
        uuids = [d["uuid"] for d in docs]
        assert uuid in uuids

    def test_list_shared_with_excludes_public(self, doc_store, user_store):
        owner_id = user_store.create("owner5", "hash")
        other_id = user_store.create("other5", "hash")
        uuid = doc_store.create("PublicOnlyDoc", owner_id)

        doc_store.set_public(uuid, True)
        docs = doc_store.list_shared_with(other_id)
        uuids = [d["uuid"] for d in docs]
        assert uuid not in uuids

    def test_search_by_name_all_includes_public(self, doc_store, user_store):
        owner_id = user_store.create("owner6", "hash")
        other_id = user_store.create("other6", "hash")
        uuid = doc_store.create("SearchablePublic", owner_id)

        doc_store.set_public(uuid, True)
        docs = doc_store.search_by_name(other_id, "SearchablePublic", filter_type="all")
        uuids = [d["uuid"] for d in docs]
        assert uuid in uuids

    def test_set_public_idempotent(self, doc_store, user_store):
        owner_id = user_store.create("owner7", "hash")
        other_id = user_store.create("other7", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        doc_store.set_public(uuid, True)
        doc_store.set_public(uuid, False)
        assert doc_store.has_permission(uuid, other_id, "view") is False

        null_rows = doc_store.db.execute(
            "SELECT COUNT(*) FROM document_shares WHERE document_uuid = ? AND shared_with_user_id IS NULL",
            (uuid,),
        ).fetchone()[0]
        assert null_rows == 0

    def test_public_not_inherited_on_unshare(self, doc_store, user_store):
        owner_id = user_store.create("owner8", "hash")
        other_id = user_store.create("other8", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert doc_store.has_permission(uuid, other_id, "view") is True

        doc_store.set_public(uuid, False)
        assert doc_store.has_permission(uuid, other_id, "view") is False
