"""Tests for database version check on startup."""

import pytest
from oversolved.db import Database, PostgreSQLConnection


def _make_db(pg_dsn):
    database = Database(PostgreSQLConnection(pg_dsn))

    def m1(db):
        db.execute("CREATE TABLE t1 (id SERIAL PRIMARY KEY)")

    def m2(db):
        db.execute("CREATE TABLE t2 (id SERIAL PRIMARY KEY)")

    database.register_migration(1, "create_t1", m1)
    database.register_migration(2, "create_t2", m2)

    return database


@pytest.fixture
def fresh_db(pg_dsn):
    db = _make_db(pg_dsn)
    yield db
    db.close()


@pytest.fixture
def migrated_db(pg_dsn):
    db = _make_db(pg_dsn)
    db.init()
    yield db
    db.close()


class TestGetLatestVersion:
    def test_no_migrations_returns_zero(self, pg_dsn):
        db = Database(PostgreSQLConnection(pg_dsn))
        assert db.get_latest_version() == 0
        db.close()

    def test_returns_highest_registered(self, pg_dsn):
        db = _make_db(pg_dsn)
        assert db.get_latest_version() == 2
        db.close()


class TestCheckVersionSync:
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

    def test_ok_when_partially_migrated(self, fresh_db):
        fresh_db.apply_migration(1, "create_t1", fresh_db._migrations[0][2])
        is_ok, current, latest = fresh_db.check_version_sync()
        assert is_ok is False
        assert current == 1
        assert latest == 2

    def test_fresh_db_no_migrations_ok(self, pg_dsn):
        db = Database(PostgreSQLConnection(pg_dsn))
        is_ok, current, latest = db.check_version_sync()
        assert is_ok is True
        assert current == 0
        assert latest == 0
        db.close()

    def test_releases_lock_after_check(self, fresh_db):
        fresh_db.check_version_sync()
        fresh_db.execute("SELECT 1")

    def test_idempotent_multiple_calls(self, fresh_db):
        for _ in range(3):
            is_ok, current, latest = fresh_db.check_version_sync()
            assert is_ok is False
            assert current == 0
            assert latest == 2
