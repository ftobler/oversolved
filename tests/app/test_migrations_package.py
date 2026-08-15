"""Tests for the oversolved.migrations auto-discovery package."""

import subprocess
import sys
import pytest
from oversolved.migrations import _load_migrations, discover_and_register
from oversolved.db import Database


class TestDiscover:
    def test_discover_returns_versions_in_order(self):
        migrations = _load_migrations()
        versions = [v for v, _, _ in migrations]
        assert versions == sorted(versions)
        assert versions == list(range(1, len(versions) + 1))

    def test_discover_rejects_duplicate_versions(self, tmp_path, monkeypatch):
        """A rogue module with a duplicate VERSION must cause ValueError at startup."""
        dup = tmp_path / "m005_dup.py"
        dup.write_text("VERSION = 5\nNAME = 'dup'\ndef apply(db): pass\n")

        import oversolved.migrations as mig_pkg
        original_path = list(mig_pkg.__path__)
        monkeypatch.setattr(mig_pkg, "__path__", [str(tmp_path)] + original_path)

        with pytest.raises(ValueError, match="Duplicate migration VERSION 5"):
            _load_migrations()

    def test_eighteen_migrations_registered(self):
        migrations = _load_migrations()
        assert len(migrations) == 18

    def test_names_match_module_slugs(self):
        migrations = _load_migrations()
        names = [n for _, n, _ in migrations]
        assert "initial_schema" in names
        assert "token_to_token_hash" in names


class TestIdempotentMigrations:
    def test_idempotent_migrations_do_not_error_when_reapplied(self, pg_dsn):
        """Migrations 006, 007, 010, 013, 014 guard with column_exists; re-running must not error."""
        from oversolved.db import PostgreSQLConnection
        db = Database(PostgreSQLConnection(pg_dsn))
        discover_and_register(db)
        db.init()

        # Re-run the idempotent migrations manually against the already-migrated schema.
        idempotent_versions = {6, 7, 10, 13, 14}
        for version, _name, apply_fn in _load_migrations():
            if version in idempotent_versions:
                apply_fn(db)  # must not raise

        db.close()


class TestTokenHashMigration:
    def test_m018_drops_plaintext_sessions(self, pg_dsn):
        """Sessions predating the hash column hold plaintext tokens and must be dropped."""
        from oversolved.db import PostgreSQLConnection, UserStore
        db = Database(PostgreSQLConnection(pg_dsn))
        discover_and_register(db)
        db.init()

        user_id = UserStore(db).create("sessionowner", "hashed_pw")
        # Recreate the pre-m018 shape so the guarded branch actually runs.
        db.execute("ALTER TABLE sessions RENAME COLUMN token_hash TO token")
        db.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            ("plaintext-token", user_id, "2999-01-01T00:00:00"),
        )
        db.commit()

        apply_fn = next(f for v, _n, f in _load_migrations() if v == 18)
        apply_fn(db)
        db.commit()

        cursor = db.execute("SELECT COUNT(*) FROM sessions")
        assert cursor.fetchone()[0] == 0
        db.close()


class TestAppStartupIntegration:
    def test_register_migrations_on_app_startup(self, pg_dsn, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})

        import psycopg2
        conn = psycopg2.connect(pg_dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM schema_version")
            count = cur.fetchone()[0]
        conn.close()

        assert count == 18, f"Expected 18 schema_version rows, got {count}"
        _ = app  # suppress unused warning


class TestNoCircularImports:
    @pytest.mark.parametrize("module", [
        "oversolved.migrations._helpers",
        "oversolved.migrations.m001_initial_schema",
        "oversolved.migrations.m006_user_oauth_prep",
        "oversolved.migrations.m018_token_to_token_hash",
        "oversolved.migrations",
    ])
    def test_no_circular_import(self, module):
        result = subprocess.run(
            [sys.executable, "-c", f"import {module}"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (
            f"Importing {module} failed:\n{result.stderr}"
        )
