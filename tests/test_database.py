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
