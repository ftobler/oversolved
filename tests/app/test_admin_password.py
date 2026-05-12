"""Tests for admin password security feature."""

import io
import logging
import os
from werkzeug.security import check_password_hash
from oversolved.app import create_app
from oversolved.db import Database, PostgreSQLConnection, UserStore


def _make_app(pg_dsn, set_env=True):
    """Create app, optionally with env var set."""
    if set_env:
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
    config = {
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
    }
    return create_app(config)


class TestAdminPassword:
    """Tests for admin password security."""

    def test_default_password_works(self, pg_dsn):
        """App starts with default password when env var is not set."""
        os.environ.pop("OVERSOLVED_ADMIN_PASSWORD", None)
        config = {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        }
        app = create_app(config)
        client = app.test_client()
        response = client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )
        assert response.status_code == 200

    def test_password_set_succeeds(self, pg_dsn):
        """create_app should succeed when OVERSOLVED_ADMIN_PASSWORD is set."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            app = _make_app(pg_dsn, set_env=True)
            client = app.test_client()
            response = client.post(
                "/api/auth/login",
                data='{"username": "admin", "password": "test_admin_password"}',
                content_type="application/json",
            )
            assert response.status_code == 200
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_password_set_succeeds_in_debug_mode(self, pg_dsn):
        """create_app should succeed in DEBUG mode when env var is set."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            config = {
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
                "DEBUG": True,
            }
            app = create_app(config)
            client = app.test_client()
            response = client.post(
                "/api/auth/login",
                data='{"username": "admin", "password": "test_admin_password"}',
                content_type="application/json",
            )
            assert response.status_code == 200
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_existing_admin_updated(self, pg_dsn):
        """Existing admin users are updated to have is_admin=1."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            create_app({
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
            })

            db = Database(PostgreSQLConnection(pg_dsn))
            db.init()
            user_store = UserStore(db)
            admin = user_store.find_by_username("admin")
            assert admin is not None
            assert admin["is_admin"] == 1
            db.close()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_new_admin_created_with_correct_attrs(self, pg_dsn):
        """New admin user is created with correct username, email, and admin privileges."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            create_app({
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
            })

            db = Database(PostgreSQLConnection(pg_dsn))
            db.init()
            user_store = UserStore(db)
            admin = user_store.find_by_username("admin")
            assert admin is not None
            assert admin["username"] == "admin"
            assert admin["email"] == "admin@local.oversolved"
            assert admin["is_admin"] == 1
            db.close()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_admin_password_hash_matches_env_var(self, pg_dsn):
        """The admin user's password hash matches the env var password."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "custom-admin-pass-123"
        try:
            create_app({
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
            })

            db = Database(PostgreSQLConnection(pg_dsn))
            db.init()
            user_store = UserStore(db)
            admin = user_store.find_by_username("admin")
            assert admin is not None
            assert check_password_hash(admin["password_hash"], "custom-admin-pass-123")
            db.close()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_no_password_printed_to_stdout(self, pg_dsn, capsys):
        """No password is printed to stdout during _ensure_admin_user execution."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            create_app({
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
            })
            captured = capsys.readouterr()
            assert "WARNING" not in captured.out
            assert "password" not in captured.out.lower()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_no_password_logged(self, pg_dsn):
        """No password is logged via the logging module."""
        log_capture = io.StringIO()
        handler = logging.StreamHandler(log_capture)
        handler.setLevel(logging.DEBUG)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)

        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            create_app({
                "DB_TYPE": "postgres",
                "TESTING": True,
                "DB_DSN": pg_dsn,
            })

            root_logger.removeHandler(handler)
            log_output = log_capture.getvalue().lower()
            assert "password" not in log_output
            assert "test_admin_password" not in log_output
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]
            root_logger.removeHandler(handler)
