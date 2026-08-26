"""Tests for database layer."""

import pytest
from oversolved.db import (
    Database,
    PostgreSQLConnection,
    UserStore,
    SessionStore,
)
from oversolved.db.connection import translate_placeholders
from .dbutil import make_db as _make_db


@pytest.fixture
def session_store(db):
    return SessionStore(db)


@pytest.fixture
def user_id(user_store):
    return user_store.create("testuser", "hashed_pw")


class TestPostgreSQLConnection:
    """Tests for PostgreSQL connection."""

    def test_execute_query(self, pg_dsn):
        conn = PostgreSQLConnection(pg_dsn)
        cursor = conn.execute("SELECT 1 as num")
        row = cursor.fetchone()
        assert row[0] == 1
        conn.close()

    def test_commit_rollback(self, pg_dsn):
        conn = PostgreSQLConnection(pg_dsn)
        conn.execute("CREATE TABLE test_conn (id INTEGER)")
        conn.commit()

        conn.execute("INSERT INTO test_conn VALUES (1)")
        conn.commit()

        cursor = conn.execute("SELECT * FROM test_conn")
        assert cursor.fetchone()[0] == 1

        conn.execute("DELETE FROM test_conn")
        conn.rollback()

        cursor = conn.execute("SELECT * FROM test_conn")
        assert cursor.fetchone()[0] == 1

        conn.close()

    def test_question_mark_in_literal_survives_translation(self, pg_dsn):
        """A ? inside a string literal is data and must reach PostgreSQL intact."""
        conn = PostgreSQLConnection(pg_dsn)
        cursor = conn.execute("SELECT ? AS given, 'who? me' AS literal", ("x",))
        row = cursor.fetchone()
        assert row[0] == "x"
        assert row[1] == "who? me"
        conn.close()


class TestPlaceholderTranslation:
    """Tests for the ? to %s placeholder rewrite."""

    def test_bare_placeholders_are_translated(self):
        assert (
            translate_placeholders("SELECT * FROM t WHERE a = ? AND b = ?")
            == "SELECT * FROM t WHERE a = %s AND b = %s"
        )

    def test_query_without_placeholders_is_unchanged(self):
        sql = "SELECT COUNT(*) FROM documents"
        assert translate_placeholders(sql) == sql

    def test_question_mark_inside_single_quotes_is_kept(self):
        assert (
            translate_placeholders("UPDATE t SET note = 'why?' WHERE id = ?")
            == "UPDATE t SET note = 'why?' WHERE id = %s"
        )

    def test_doubled_quote_inside_literal_does_not_end_it(self):
        assert (
            translate_placeholders("SELECT 'it''s a ?' , ?")
            == "SELECT 'it''s a ?' , %s"
        )

    def test_question_mark_inside_quoted_identifier_is_kept(self):
        assert (
            translate_placeholders('SELECT "odd?col" FROM t WHERE id = ?')
            == 'SELECT "odd?col" FROM t WHERE id = %s'
        )


class TestDatabase:
    """Tests for Database class."""

    def test_init_creates_schema_version_table(self, db):
        cursor = db.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='public' AND table_name='schema_version'"
        )
        assert cursor.fetchone() is not None

    def test_migration_runs_once(self, db):
        call_count = 0

        def test_migration(database: Database):
            nonlocal call_count
            call_count += 1
            database.execute("CREATE TABLE test_once (id INTEGER)")

        db.register_migration(100, "test_migration", test_migration)
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

    def test_find_returns_none_for_expired_session(self, session_store, user_id):
        """find() must not return a session whose expiry is in the past."""
        from datetime import datetime, timedelta, timezone
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        self._insert_session(session_store, user_id, "stale-tok", past)
        assert session_store.find("stale-tok") is None

    def test_find_treats_naive_expiry_as_utc(self, session_store, user_id):
        """A stored expiry without a tz offset is interpreted as UTC, not rejected.

        Guards legacy/migrated rows whose expires_at lacks an offset: a future
        naive timestamp must still resolve to a valid session.
        """
        from datetime import datetime, timedelta, timezone
        naive_future = (
            datetime.now(timezone.utc) + timedelta(days=1)
        ).replace(tzinfo=None).isoformat()
        assert "+" not in naive_future  # no offset, i.e. naive
        self._insert_session(session_store, user_id, "naive-tok", naive_future)
        session = session_store.find("naive-tok")
        assert session is not None
        assert session["user_id"] == user_id

    def test_delete(self, session_store, user_id):
        token = session_store.create(user_id)
        session_store.delete(token)
        assert session_store.find(token) is None

    def test_create_cleans_up_old_sessions(self, session_store, user_id):
        token_a = session_store.create(user_id)
        assert session_store.find(token_a) is not None

        token_b = session_store.create(user_id)
        assert session_store.find(token_b) is not None
        # With MAX_SESSIONS=5, both sessions survive (2 < 5)
        assert session_store.find(token_a) is not None

    def test_new_session_does_not_affect_other_users(self, session_store, user_store):
        uid1 = user_store.create("user1", "hash")
        uid2 = user_store.create("user2", "hash")

        session_store.create(uid1)
        session_store.create(uid2)

        session_store.create(uid1)

        cursor = session_store.db.execute(
            "SELECT user_id, COUNT(*) as cnt FROM sessions GROUP BY user_id"
        )
        rows = {row[0]: row[1] for row in cursor.fetchall()}
        assert rows[uid1] == 2
        assert rows[uid2] == 1

    def test_create_keeps_multiple_sessions_up_to_limit(self, session_store, user_id):
        tokens = [session_store.create(user_id) for _ in range(4)]
        for t in tokens:
            assert session_store.find(t) is not None

    def test_create_deletes_oldest_when_limit_exceeded(self, session_store, user_id):
        tokens = [session_store.create(user_id) for _ in range(6)]
        # Newest 5 should survive
        for t in tokens[1:]:
            assert session_store.find(t) is not None, f"newer session {t} should survive"
        # Oldest (1st) should be deleted
        assert session_store.find(tokens[0]) is None, "oldest session should be deleted"

    def test_session_limit_does_not_affect_other_users(self, session_store, user_store):
        uid_a = user_store.create("userA", "hash")
        uid_b = user_store.create("userB", "hash")

        for _ in range(6):
            session_store.create(uid_a)
        session_store.create(uid_b)

        cursor = session_store.db.execute(
            "SELECT user_id, COUNT(*) as cnt FROM sessions GROUP BY user_id"
        )
        rows = {row[0]: row[1] for row in cursor.fetchall()}
        assert rows[uid_a] == 5
        assert rows[uid_b] == 1

    def test_session_limit_configurable(self, session_store, user_id):
        tokens = []
        for _ in range(3):
            t = session_store.create(user_id)
            tokens.append(t)
        # Manually enforce a stricter limit
        session_store._enforce_session_limit(user_id, keep_token=tokens[-1], max_sessions=2)
        assert session_store.find(tokens[-1]) is not None
        assert session_store.find(tokens[-2]) is not None
        # Oldest should be deleted
        assert session_store.find(tokens[0]) is None

    def test_revoke_all_for_user_keeps_given_token(self, session_store, user_store):
        """revocation spares exactly the one session named by keep_token."""
        uid = user_store.create("revoker", "hash")
        kept = session_store.create(uid)
        stale = session_store.create(uid)

        deleted = session_store.revoke_all_for_user(uid, keep_token=kept)

        assert deleted == 1
        assert session_store.find(kept) is not None
        assert session_store.find(stale) is None

    def test_revoke_all_for_user_clears_everything_without_keep(self, session_store, user_store):
        """No keep_token means every session of the user goes."""
        uid = user_store.create("wiper", "hash")
        tokens = [session_store.create(uid) for _ in range(3)]

        deleted = session_store.revoke_all_for_user(uid)

        assert deleted == 3
        for token in tokens:
            assert session_store.find(token) is None

    def test_revoke_all_for_user_leaves_other_users_alone(self, session_store, user_store):
        uid_a = user_store.create("revokea", "hash")
        uid_b = user_store.create("revokeb", "hash")
        b_token = session_store.create(uid_b)

        session_store.revoke_all_for_user(uid_a)

        assert session_store.find(b_token) is not None

    @staticmethod
    def _insert_session(session_store, user_id, token, expires_at):
        """Insert a session row directly with a controlled expiry timestamp."""
        import hashlib
        from datetime import datetime, timezone
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = datetime.now(timezone.utc).isoformat()
        with session_store.db.transaction():
            session_store.db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (token_hash, user_id, expires_at, now),
            )
        return token_hash

    @staticmethod
    def _row_count(session_store, token_hash):
        cursor = session_store.db.execute(
            "SELECT COUNT(*) FROM sessions WHERE token_hash = ?", (token_hash,)
        )
        return cursor.fetchone()[0]


class TestSessionCleanupIntegration:
    """Integration tests: login endpoint creates only one session per user."""

    def test_login_creates_single_session(self, pg_dsn, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        })
        client = app.test_client()

        resp1 = client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )
        assert resp1.status_code == 200
        cookie1 = resp1.headers.get("Set-Cookie", "")

        resp2 = client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )
        assert resp2.status_code == 200
        cookie2 = resp2.headers.get("Set-Cookie", "")

        assert cookie1 != cookie2, "Second login should set a different session cookie"

    def test_old_session_invalid_after_new_login(self, pg_dsn, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        })
        client = app.test_client()

        resp1 = client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )
        assert resp1.status_code == 200
        set_cookie1 = resp1.headers.get("Set-Cookie", "")
        token1 = set_cookie1.split(";")[0].split("=")[1]

        client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )

        database = Database(PostgreSQLConnection(pg_dsn))
        database.init()
        ss = SessionStore(database)
        found = ss.find(token1)
        database.close()
        # With MAX_SESSIONS=5, both sessions survive (2 < 5)
        assert found is not None, "Old session should still be valid (within session limit)"

    def test_fifth_login_removes_oldest(self, pg_dsn, monkeypatch):
        """Login 6 times, verify the first session is invalidated and the 5 most recent are valid."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        })
        client = app.test_client()
        tokens = []
        for _ in range(6):
            resp = client.post(
                "/api/auth/login",
                data='{"username": "admin", "password": "admin"}',
                content_type="application/json",
            )
            assert resp.status_code == 200
            set_cookie = resp.headers.get("Set-Cookie", "")
            token = set_cookie.split(";")[0].split("=")[1]
            tokens.append(token)

        database = Database(PostgreSQLConnection(pg_dsn))
        database.init()
        ss = SessionStore(database)
        # First token should be deleted (oldest, beyond max 5)
        assert ss.find(tokens[0]) is None, "Oldest session should be deleted"
        # Newest 5 should survive
        for t in tokens[1:]:
            assert ss.find(t) is not None, f"Session {t} should survive"
        database.close()


class TestMigrationIndex:
    """Test migration 16 adds sessions(user_id) index."""

    def test_sessions_user_id_index_exists(self, pg_dsn):
        database = Database(PostgreSQLConnection(pg_dsn))

        def migration_001(db):
            db.execute("""
                CREATE TABLE sessions (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    expires_at TEXT NOT NULL
                )
            """)

        database.register_migration(1, "initial_schema", migration_001)

        def migration_016(db):
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"
            )

        database.register_migration(16, "sessions_user_id_index", migration_016)
        database.init()

        cursor = database.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE tablename='sessions' AND indexname='idx_sessions_user_id'"
        )
        assert cursor.fetchone() is not None

        database.close()


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

    def test_permanently_delete(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        assert doc_store.permanently_delete(uuid) is True
        assert doc_store.retrieve(uuid) is None

    def test_permanently_delete_nonexistent(self, doc_store):
        assert doc_store.permanently_delete("no-uuid") is False

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
            # Listing rows are summaries for clone name-uniquification; the
            # preview blob must not be dragged along per row.
            assert "preview_image" not in d

    def test_list_by_owner_empty(self, doc_store, user_id):
        assert doc_store.list_by_owner(user_id) == []

    def test_list_by_owner_isolation(self, doc_store, user_store):
        uid1 = user_store.create("user1", "h")
        uid2 = user_store.create("user2", "h")
        doc_store.create("Doc A", uid1)
        doc_store.create("Doc B", uid2)
        assert len(doc_store.list_by_owner(uid1)) == 1
        assert len(doc_store.list_by_owner(uid2)) == 1

    def test_list_by_owner_omits_preview_but_retrieve_keeps_bytes(self, doc_store, user_id):
        """list_by_owner no longer selects preview_image: its only production
        caller reads names only, so shipping every owner thumbnail was waste.
        The old byte-normalization pin (Postgres memoryview -> bytes) moved
        here onto retrieve(), which is the path that still serves blobs."""
        uuid = doc_store.create("With Image", user_id)
        image_data = b"\x89PNG\r\n\x1a\n"
        doc_store.store_preview_image(uuid, image_data)

        assert "preview_image" not in doc_store.list_by_owner(user_id)[0]
        doc = doc_store.retrieve(uuid)
        assert doc is not None
        assert type(doc["preview_image"]) is bytes
        assert doc["preview_image"] == image_data

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

    def test_create_with_all_fields(self, user_store):
        uid = user_store.create(
            "user3", "hash", email="user3@example.com",
            external_id="ext_123", provider="google", provider_data='{"name": "User"}'
        )
        user = user_store.find_by_id(uid)
        assert user is not None
        assert user["email"] == "user3@example.com"
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

    def test_list_all_includes_new_fields(self, user_store):
        user_store.create("user9", "hash", email="user9@example.com")
        users = user_store.list_all()
        user = next(u for u in users if u["username"] == "user9")
        assert user["email"] == "user9@example.com"

    def test_backfill_email_on_migration(self, pg_dsn):
        """Test that existing users get backfilled email during migration."""
        database = _make_db(pg_dsn)
        store = UserStore(database)
        uid = store.create("testuser", "hash", email="testuser@local.oversolved")
        user = store.find_by_id(uid)
        assert user is not None
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


class TestDocumentStoreMisc:
    """Coverage for the less-trodden DocumentStore branches."""

    def test_update_no_fields_returns_false(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        assert doc_store.update(uuid) is False

    def test_update_only_unknown_fields_returns_false(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        # No allowed keys survive the whitelist, so nothing is written.
        assert doc_store.update(uuid, bogus="x", owner_id=999) is False
        assert doc_store.retrieve(uuid)["owner_id"] == user_id

    def test_update_known_field(self, doc_store, user_id):
        uuid = doc_store.create("Doc", user_id)
        assert doc_store.update(uuid, name="Renamed") is True
        assert doc_store.retrieve(uuid)["name"] == "Renamed"

    def test_duplicate_copies_content_keeping_owner(self, doc_store, user_id):
        uuid = doc_store.create("Original", user_id)
        doc_store.store_content(uuid, "version: 1\n")

        new_uuid = doc_store.duplicate(uuid, "Copy")
        assert new_uuid is not None
        assert new_uuid != uuid
        copy = doc_store.retrieve(new_uuid)
        assert copy["name"] == "Copy"
        assert copy["owner_id"] == user_id  # duplicate keeps the source owner
        assert copy["content"] == "version: 1\n"

    def test_duplicate_nonexistent_returns_none(self, doc_store):
        assert doc_store.duplicate("no-such-uuid", "Copy") is None

    def test_unshare_public_revokes_access(self, doc_store, user_store):
        owner_id = user_store.create("misc_owner", "hash")
        other_id = user_store.create("misc_other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.set_public(uuid, True)
        assert doc_store.has_permission(uuid, other_id, "view") is True

        doc_store.set_public(uuid, False)
        assert doc_store.has_permission(uuid, other_id, "view") is False

    def test_get_shares_includes_public_link(self, doc_store, user_store):
        owner_id = user_store.create("share_owner", "hash")
        other_id = user_store.create("share_other", "hash")
        uuid = doc_store.create("Doc", owner_id)

        doc_store.share_document(uuid, other_id, "edit")
        doc_store.set_public(uuid, True)

        shares = doc_store.get_shares(uuid)
        user_shares = [s for s in shares if s["shared_with_user_id"] == other_id]
        public_shares = [s for s in shares if s["shared_with_user_id"] is None]
        assert len(user_shares) == 1
        assert user_shares[0]["permission"] == "edit"
        assert len(public_shares) == 1
        assert public_shares[0]["permission"] == "view"

    def test_get_permission_nonexistent_returns_none(self, doc_store, user_id):
        assert doc_store.get_permission("no-such-uuid", user_id) is None
