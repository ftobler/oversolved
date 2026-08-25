"""Tests for the staticserve CLI route path guard.

staticserve builds its Flask app inline and blocks inside waitress.serve, so
the tests stub waitress to capture the app and drive it with the test client.
"""

import argparse
import pathlib
import sys

import pytest

from oversolved.cli import staticserve


class _StubWaitress:
    app_captured = None

    @staticmethod
    def serve(application, host=None, port=None):
        _StubWaitress.app_captured = application


@pytest.fixture
def served_app(monkeypatch, tmp_path):
    public = tmp_path / "public"
    public.mkdir()
    monkeypatch.setitem(sys.modules, "waitress", _StubWaitress)
    args = argparse.Namespace(public=str(public), host="127.0.0.1", port=0)
    staticserve(args)
    return _StubWaitress.app_captured


def test_resolve_oserror_returns_404(served_app, monkeypatch):
    """OSError from resolve() must surface as 404, not an unhandled error."""

    def boom(self, strict=False):
        raise OSError("resolve failed")

    monkeypatch.setattr(pathlib.Path, "resolve", boom)
    response = served_app.test_client().get("/whatever")
    assert response.status_code == 404


def test_traversal_outside_public_returns_404(served_app):
    response = served_app.test_client().get("/../../../etc/passwd")
    assert response.status_code == 404
