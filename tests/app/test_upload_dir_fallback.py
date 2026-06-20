"""Tests for get_upload_dir fallback outside an application context.

These do not require OpenCascade, unlike the route tests in
test_api_upload.py, so they cover the RuntimeError fallback branch that the
skipped upload tests never reach.
"""

import os

from oversolved.blueprints.upload_export import get_upload_dir


def test_fallback_uses_env_var(monkeypatch):
    """Outside an app context, get_upload_dir reads OVERSOLVED_UPLOAD_DIR."""
    monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", "/tmp/custom_upload_dir")
    assert get_upload_dir() == "/tmp/custom_upload_dir"


def test_fallback_default_path(monkeypatch):
    """Without the env var, get_upload_dir returns the bundled uploads dir."""
    monkeypatch.delenv("OVERSOLVED_UPLOAD_DIR", raising=False)
    result = get_upload_dir()
    assert os.path.basename(result) == "uploads"
    assert os.path.isabs(result)
