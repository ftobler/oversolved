"""Tests for admin password security feature."""

import os
import pytest
from oversolved.app import create_app


def _make_app(tmp_path, debug: bool):
    """Create app with given DEBUG setting and no password env var."""
    db_path = str(tmp_path / "test.db")
    config = {
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": db_path,
        "DEBUG": debug,
    }
    return create_app(config)


class TestAdminPassword:
    """Tests for admin password security."""

    def test_missing_password_raises_in_production(self, tmp_path):
        """create_app should raise RuntimeError when password not set and DEBUG=False."""
        with pytest.raises(RuntimeError, match="OVERSOLVED_ADMIN_PASSWORD must be set"):
            _make_app(tmp_path, debug=False)

    def test_missing_password_warns_in_debug_mode(self, tmp_path, capsys):
        """create_app should warn but not raise in DEBUG mode."""
        _make_app(tmp_path, debug=True)
        captured = capsys.readouterr()
        assert "WARNING" in captured.out

    def test_password_set_succeeds(self, tmp_path):
        """create_app should succeed when OVERSOLVED_ADMIN_PASSWORD is set."""
        os.environ["OVERSOLVED_ADMIN_PASSWORD"] = "test_admin_password"
        try:
            app = _make_app(tmp_path, debug=False)
            client = app.test_client()
            response = client.post(
                "/api/auth/login",
                data='{"username": "admin", "password": "test_admin_password"}',
                content_type="application/json",
            )
            assert response.status_code == 200
        finally:
            del os.environ["OVERSOLVED_ADMIN_PASSWORD"]
