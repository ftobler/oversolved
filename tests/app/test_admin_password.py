"""Tests for admin password security feature."""

import io
import logging
import os
import pytest
from werkzeug.security import check_password_hash
from oversolved.app import create_app
from oversolved.db import Database, SQLiteConnection, UserStore


def _make_app(tmp_path, set_env=True):
    """Create app, optionally with env var set."""
    if set_env:
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
    db_path = str(tmp_path / "test.db")
    config = {
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": db_path,
    }
    return create_app(config)


class TestAdminPassword:
    """Tests for admin password security."""

    def test_missing_password_raises_in_production(self, tmp_path):
        """create_app should raise RuntimeError when password not set and DEBUG=False."""
        with pytest.raises(RuntimeError, match="OVERSOLVED_ADMIN_PASSWORD must be set"):
            _make_app(tmp_path, set_env=False)

    def test_missing_password_raises_in_debug_mode(self, tmp_path):
        """create_app should raise RuntimeError when password not set even in DEBUG mode."""
        with pytest.raises(RuntimeError, match="OVERSOLVED_ADMIN_PASSWORD must be set"):
            db_path = str(tmp_path / "test_debug.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
                "DEBUG": True,
            }
            create_app(config)

    def test_password_set_succeeds(self, tmp_path):
        """create_app should succeed when OVERSOLVED_ADMIN_PASSWORD is set."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            app = _make_app(tmp_path, set_env=True)
            client = app.test_client()
            response = client.post(
                "/api/auth/login",
                data='{"username": "admin", "password": "test_admin_password"}',
                content_type="application/json",
            )
            assert response.status_code == 200
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_password_set_succeeds_in_debug_mode(self, tmp_path):
        """create_app should succeed in DEBUG mode when env var is set."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            db_path = str(tmp_path / "test_debug_ok.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
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

    def test_existing_admin_updated(self, tmp_path):
        """Existing admin users are updated to have is_admin=1."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            db_path = str(tmp_path / "test_existing.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
            }
            create_app(config)

            db_path_str = str(tmp_path / "test_existing.db")
            db = Database(SQLiteConnection(db_path_str))
            db.init()
            user_store = UserStore(db)
            admin = user_store.find_by_username("admin")
            assert admin is not None
            assert admin["is_admin"] == 1
            db.close()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_new_admin_created_with_correct_attrs(self, tmp_path):
        """New admin user is created with correct username, email, and admin privileges."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            db_path = str(tmp_path / "test_new_admin.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
            }
            create_app(config)

            db_path_str = str(tmp_path / "test_new_admin.db")
            db = Database(SQLiteConnection(db_path_str))
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

    def test_admin_password_hash_matches_env_var(self, tmp_path):
        """The admin user's password hash matches the env var password."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "custom-admin-pass-123"
        try:
            db_path = str(tmp_path / "test_hash.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
            }
            create_app(config)

            db_path_str = str(tmp_path / "test_hash.db")
            db = Database(SQLiteConnection(db_path_str))
            db.init()
            user_store = UserStore(db)
            admin = user_store.find_by_username("admin")
            assert admin is not None
            assert check_password_hash(admin["password_hash"], "custom-admin-pass-123")
            db.close()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_no_password_printed_to_stdout(self, tmp_path, capsys):
        """No password is printed to stdout during _ensure_admin_user execution."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            db_path = str(tmp_path / "test_noprint.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
            }
            create_app(config)
            captured = capsys.readouterr()
            assert "WARNING" not in captured.out
            assert "password" not in captured.out.lower()
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]

    def test_no_password_logged(self, tmp_path):
        """No password is logged via the logging module."""
        log_capture = io.StringIO()
        handler = logging.StreamHandler(log_capture)
        handler.setLevel(logging.DEBUG)
        root_logger = logging.getLogger()
        root_logger.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)

        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            db_path = str(tmp_path / "test_nolog.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
            }
            create_app(config)

            root_logger.removeHandler(handler)
            log_output = log_capture.getvalue().lower()
            assert "password" not in log_output
            assert "test_admin_password" not in log_output
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]
            root_logger.removeHandler(handler)

    def test_startup_fails_without_env_var(self, tmp_path):
        """create_app fails when OVERSOLVED_ADMIN_PASSWORD is unset, regardless of debug."""
        for debug_val in (True, False):
            db_path = str(tmp_path / f"test_fail_{debug_val}.db")
            config = {
                "DB_TYPE": "sqlite",
                "TESTING": True,
                "DB_PATH": db_path,
                "DEBUG": debug_val,
            }
            with pytest.raises(RuntimeError, match="OVERSOLVED_ADMIN_PASSWORD must be set"):
                create_app(config)
