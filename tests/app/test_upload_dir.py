"""Unit tests for upload_export.get_upload_dir fallback.

These cover the no-app-context branch (RuntimeError from current_app),
which the OCP-gated upload route tests in test_api_upload.py never reach.
"""

import os

from oversolved.blueprints import upload_export
from oversolved.blueprints.upload_export import get_upload_dir


def test_get_upload_dir_uses_env_var_outside_app_context(monkeypatch):
    """Outside an app context current_app raises RuntimeError, so the
    OVERSOLVED_UPLOAD_DIR env var is used."""
    monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", "/tmp/custom_upload_dir")
    assert get_upload_dir() == "/tmp/custom_upload_dir"


def test_get_upload_dir_defaults_to_package_uploads(monkeypatch):
    """Without the env var, the fallback resolves to the package uploads dir."""
    monkeypatch.delenv("OVERSOLVED_UPLOAD_DIR", raising=False)
    expected = os.path.normpath(
        os.path.join(os.path.dirname(upload_export.__file__), "..", "uploads")
    )
    assert get_upload_dir() == expected


def test_fallback_default_path(monkeypatch):
    """Without the env var the result ends in 'uploads' and is absolute."""
    monkeypatch.delenv("OVERSOLVED_UPLOAD_DIR", raising=False)
    result = get_upload_dir()
    assert os.path.basename(result) == "uploads"
    assert os.path.isabs(result)


def test_get_upload_dir_prefers_app_config(pg_dsn, tmp_path, monkeypatch):
    """Inside an app context the configured upload_dir wins over the env var."""
    from oversolved.app import create_app

    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    # Env var points elsewhere to prove app config takes precedence.
    monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", str(tmp_path / "env_dir"))
    test_app = create_app(
        {"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn}
    )
    configured = test_app.config["OVERSOLVED"].upload_dir
    with test_app.app_context():
        assert get_upload_dir() == configured
