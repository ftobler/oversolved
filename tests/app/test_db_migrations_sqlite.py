"""Tests for the SQLite-backed branches of Database migrations.

The postgres branches of check_version_sync and friends are covered in
test_db_version_check.py. These tests exercise the SQLite lock path, the
apply_migration rollback, and the _to_bytes normalizer with no postgres needed.
"""

import pytest
from oversolved.db import Database, SQLiteConnection
from oversolved.db.documents import _to_bytes


def _make_db():
    database = Database(SQLiteConnection(":memory:"))

    def m1(db):
        db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)")

    def m2(db):
        db.execute("CREATE TABLE t2 (id INTEGER PRIMARY KEY)")

    database.register_migration(1, "create_t1", m1)
    database.register_migration(2, "create_t2", m2)
    return database


@pytest.fixture
def fresh_db():
    db = _make_db()
    yield db
    db.close()


@pytest.fixture
def migrated_db():
    db = _make_db()
    db.init()
    yield db
    db.close()


class TestCheckVersionSyncSqlite:
    """Exercise the non-postgres lock branch of check_version_sync."""

    def test_ok_when_up_to_date(self, migrated_db):
        is_ok, current, latest = migrated_db.check_version_sync()
        assert is_ok is True
        assert current == 2
        assert latest == 2

    def test_not_ok_when_pending(self, fresh_db):
        is_ok, current, latest = fresh_db.check_version_sync()
        assert is_ok is False
        assert current == 0
        assert latest == 2

    def test_lock_released_allows_followup_query(self, fresh_db):
        # The finally block rolls back to release the BEGIN IMMEDIATE lock,
        # so a subsequent statement must not deadlock or error.
        fresh_db.check_version_sync()
        fresh_db.execute("SELECT 1")

    def test_idempotent_multiple_calls(self, fresh_db):
        for _ in range(3):
            is_ok, current, latest = fresh_db.check_version_sync()
            assert is_ok is False
            assert current == 0
            assert latest == 2

    def test_no_migrations_is_ok(self):
        db = Database(SQLiteConnection(":memory:"))
        is_ok, current, latest = db.check_version_sync()
        assert is_ok is True
        assert current == 0
        assert latest == 0
        db.close()


class TestApplyMigrationRollback:
    """Cover the failure path of apply_migration."""

    def test_failing_migration_reraises(self, fresh_db):
        def boom(db):
            raise ValueError("migration blew up")

        with pytest.raises(ValueError, match="migration blew up"):
            fresh_db.apply_migration(1, "boom", boom)

    def test_failing_migration_does_not_record_version(self, fresh_db):
        def boom(db):
            raise RuntimeError("nope")

        with pytest.raises(RuntimeError):
            fresh_db.apply_migration(1, "boom", boom)
        # The version row was never inserted, so we are still at version 0.
        assert fresh_db.get_current_version() == 0

    def test_rollback_invoked_on_failure(self, fresh_db):
        # Spy on the connection rollback to confirm the except branch runs it.
        calls = []
        original = fresh_db.conn.rollback

        def spy_rollback():
            calls.append(1)
            original()

        fresh_db.conn.rollback = spy_rollback

        def boom(db):
            raise ValueError("kaboom")

        with pytest.raises(ValueError):
            fresh_db.apply_migration(1, "boom", boom)
        assert calls, "rollback was not called on migration failure"

    def test_failing_migration_leaves_no_partial_ddl_sqlite(self, tmp_path):
        """SQLite DDL inside a failed migration must roll back, not autocommit."""
        db_path = str(tmp_path / "partial.sqlite")

        def halfway(db):
            db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)")
            db.execute("CREATE TABLE t2 (id INTEGER PRIMARY KEY)")
            raise RuntimeError("halfway through")

        first = Database(SQLiteConnection(db_path))
        first.register_migration(1, "m001_halfway", halfway)
        with pytest.raises(RuntimeError):
            first.init()

        names = [
            row[0]
            for row in first.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        ]
        assert "t1" not in names and "t2" not in names
        assert first.get_current_version() == 0
        first.close()

    def test_retry_after_failed_migration_succeeds_on_same_file(self, tmp_path):
        """Reopening a db that saw a failed migration must migrate cleanly.

        Without atomic DDL the partial table survives and init() boot-loops
        on "table already exists".
        """
        db_path = str(tmp_path / "retry.sqlite")

        def bad(db):
            db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)")
            raise RuntimeError("boom")

        broken = Database(SQLiteConnection(db_path))
        broken.register_migration(1, "m001_bad", bad)
        with pytest.raises(RuntimeError):
            broken.init()
        broken.close()

        def fixed(db):
            db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)")

        reopened = Database(SQLiteConnection(db_path))
        reopened.register_migration(1, "m001_fixed", fixed)
        reopened.init()
        assert reopened.get_current_version() == 1
        reopened.close()


class TestToBytes:
    def test_none_returns_none(self):
        assert _to_bytes(None) is None

    def test_memoryview_is_copied_to_bytes(self):
        value = memoryview(b"abc")
        result = _to_bytes(value)
        assert result == b"abc"
        assert isinstance(result, bytes)

    def test_bytes_pass_through(self):
        value = b"already-bytes"
        assert _to_bytes(value) is value
