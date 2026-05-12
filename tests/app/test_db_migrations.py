"""Tests for DB migration CLI and refactored Database methods."""

import json
import pytest
from oversolved.db import Database, PostgreSQLConnection


def _make_db(pg_dsn, with_migrations=False):
    database = Database(PostgreSQLConnection(pg_dsn))

    if with_migrations:
        def m1(db):
            db.execute("CREATE TABLE t1 (id SERIAL PRIMARY KEY)")

        def m2(db):
            db.execute("CREATE TABLE t2 (id SERIAL PRIMARY KEY)")

        def m3(db):
            db.execute("CREATE TABLE t3 (id SERIAL PRIMARY KEY)")

        database.register_migration(1, "create_t1", m1)
        database.register_migration(2, "create_t2", m2)
        database.register_migration(3, "create_t3", m3)

    return database


@pytest.fixture
def fresh_db(pg_dsn):
    db = _make_db(pg_dsn, with_migrations=True)
    yield db
    db.close()


class TestGetCurrentVersion:
    def test_get_current_version_fresh_db(self, pg_dsn):
        db = _make_db(pg_dsn)
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
    def test_apply_migration(self, pg_dsn):
        db = _make_db(pg_dsn)

        def m1(d):
            d.execute("CREATE TABLE test_table (id SERIAL PRIMARY KEY)")
        db.register_migration(1, "create_test_table", m1)

        db.apply_migration(1, "create_test_table", m1)

        cursor = db.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='public' AND table_name='test_table'"
        )
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
    def test_upgrade_cli(self, pg_dsn):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
            "upgrade",
        ])
        cmd_db(args)

        database2 = Database(PostgreSQLConnection(pg_dsn))
        assert database2.get_current_version() > 0
        database2.close()

    def test_migrations_not_registered_on_every_request(self, pg_dsn, monkeypatch):
        """_register_migrations should only be called at startup, not per-request."""
        import oversolved.app as app_mod
        registry_calls = []

        orig_register = app_mod._register_migrations

        def tracking_register(db):
            registry_calls.append(1)
            return orig_register(db)

        monkeypatch.setattr(app_mod, "_register_migrations", tracking_register)
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")

        app = app_mod.create_app({
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        })
        client = app.test_client()
        client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )

        for _ in range(3):
            resp = client.get("/api/documents")
            assert resp.status_code == 200

        assert len(registry_calls) == 1

    def test_upgrade_twice_is_noop(self, pg_dsn):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
            "upgrade",
        ])

        cmd_db(args)
        cmd_db(args)

        database = Database(PostgreSQLConnection(pg_dsn))
        cursor = database.execute("SELECT COUNT(*) FROM schema_version")
        count = cursor.fetchone()[0]
        assert count > 0
        database.close()


class TestStatusCLI:
    def test_status_cli(self, capsys, pg_dsn):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
            "status",
        ])

        cmd_db(args)
        captured = capsys.readouterr()
        assert "Schema version:" in captured.out
        assert "Version" in captured.out


class TestCheckCLI:
    def test_check_cli_pending(self, pg_dsn):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()
        args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
            "check",
        ])

        with pytest.raises(SystemExit) as exc:
            cmd_db(args)
        assert exc.value.code == 1

    def test_check_cli_up_to_date(self, pg_dsn):
        from oversolved.cli import build_parser, cmd_db

        parser = build_parser()

        up_args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
            "upgrade",
        ])
        cmd_db(up_args)

        args = parser.parse_args([
            "db", "--db-type", "postgres", "--db-dsn", pg_dsn,
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

        args = parser.parse_args(["db", "--db-type", "postgres", "upgrade"])
        assert args.command == "db"
        assert args.db_command == "upgrade"
        assert args.db_type == "postgres"

        args = parser.parse_args(["db", "check"])
        assert args.command == "db"
        assert args.db_command == "check"
