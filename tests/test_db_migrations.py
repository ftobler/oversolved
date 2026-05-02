"""Tests for DB migration CLI and refactored Database methods."""

import pytest
from oversolved.db import Database, SQLiteConnection


def _make_db(with_migrations=False):
    conn = SQLiteConnection(":memory:")
    database = Database(conn)

    if with_migrations:
        def m1(db):
            db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)")

        def m2(db):
            db.execute("CREATE TABLE t2 (id INTEGER PRIMARY KEY)")

        def m3(db):
            db.execute("CREATE TABLE t3 (id INTEGER PRIMARY KEY)")

        database.register_migration(1, "create_t1", m1)
        database.register_migration(2, "create_t2", m2)
        database.register_migration(3, "create_t3", m3)

    return database


@pytest.fixture
def fresh_db():
    db = _make_db(with_migrations=True)
    yield db
    db.close()


class TestGetCurrentVersion:
    def test_get_current_version_fresh_db(self):
        db = _make_db()
        assert db.get_current_version() == 0
        db.close()

    def test_get_current_version_after_migration(self, fresh_db):
        fresh_db.init()
        assert fresh_db.get_current_version() == 3


class TestGetPendingMigrations:
    def test_get_pending_migrations_none(self, fresh_db):
        fresh_db.init()
        pending = fresh_db.get_pending_migrations()
        assert pending == []

    def test_get_pending_migrations_some(self, fresh_db):
        fresh_db.apply_migration(1, "create_t1", fresh_db._migrations[0][2])
        pending = fresh_db.get_pending_migrations()
        assert len(pending) == 2
        assert pending[0][0] == 2
        assert pending[1][0] == 3


class TestApplyMigration:
    def test_apply_migration(self):
        db = _make_db()

        def m1(d):
            d.execute("CREATE TABLE test_table (id INTEGER PRIMARY KEY)")
        db.register_migration(1, "create_test_table", m1)

        db.apply_migration(1, "create_test_table", m1)

        cursor = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
        assert cursor.fetchone() is not None

        cursor = db.execute("SELECT version, name FROM schema_version WHERE version = 1")
        row = cursor.fetchone()
        assert row is not None
        assert row[1] == "create_test_table"

        db.close()

    def test_migration_idempotency(self, fresh_db):
        fresh_db.init()
        cursor = fresh_db.execute("SELECT COUNT(*) FROM schema_version")
        count_before = cursor.fetchone()[0]

        fresh_db.init()

        cursor = fresh_db.execute("SELECT COUNT(*) FROM schema_version")
        count_after = cursor.fetchone()[0]
        assert count_before == count_after == 3


class TestUpgradeCLI:
    def test_upgrade_cli(self, tmp_path):
        db_path = str(tmp_path / "test.db")

        conn = SQLiteConnection(db_path)
        database = Database(conn)
        database.get_current_version()
        assert database.get_current_version() == 0
        database.close()

        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "upgrade",
        ])
        cmd_db(args)

        conn2 = SQLiteConnection(db_path)
        database2 = Database(conn2)
        assert database2.get_current_version() > 0
        database2.close()

    def test_upgrade_twice_is_noop(self, tmp_path):
        db_path = str(tmp_path / "test2.db")

        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "upgrade",
        ])

        cmd_db(args)
        cmd_db(args)

        conn = SQLiteConnection(db_path)
        database = Database(conn)
        cursor = database.execute("SELECT COUNT(*) FROM schema_version")
        count = cursor.fetchone()[0]
        assert count > 0
        database.close()


class TestStatusCLI:
    def test_status_cli(self, capsys, tmp_path):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        db_path = str(tmp_path / "test3.db")
        args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "status",
        ])

        cmd_db(args)
        captured = capsys.readouterr()
        assert "Schema version:" in captured.out
        assert "Version" in captured.out


class TestCheckCLI:
    def test_check_cli_pending(self, tmp_path):
        db_path = str(tmp_path / "test4.db")

        conn = SQLiteConnection(db_path)
        database = Database(conn)
        database.get_current_version()
        database.close()

        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "check",
        ])

        with pytest.raises(SystemExit) as exc:
            cmd_db(args)
        assert exc.value.code == 1

    def test_check_cli_up_to_date(self, tmp_path):
        db_path = str(tmp_path / "test5.db")

        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()

        up_args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "upgrade",
        ])
        cmd_db(up_args)

        args = parser.parse_args([
            "db", "--db-type", "sqlite", "--db-path", db_path,
            "check",
        ])
        cmd_db(args)


class TestCliDbArgParsing:
    def test_db_subcommand_parse(self):
        from oversolved.cli import build_parser
        parser = build_parser()

        args = parser.parse_args(["db", "status"])
        assert args.command == "db"
        assert args.db_command == "status"

        args = parser.parse_args(["db", "--db-type", "sqlite", "upgrade"])
        assert args.command == "db"
        assert args.db_command == "upgrade"
        assert args.db_type == "sqlite"

        args = parser.parse_args(["db", "check"])
        assert args.command == "db"
        assert args.db_command == "check"
