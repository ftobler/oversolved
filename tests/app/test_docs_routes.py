"""Tests for the documentation blueprint's defensive branches.

The happy paths (list, fetch, 404) live in test_api.py::TestDocsAPI. These
cover the branches that route-level requests cannot reach or that depend on
filesystem state: the path-traversal guard, the missing-docs-dir fallback,
and a read failure.
"""

import pathlib

import pytest

from oversolved.app import create_app
from oversolved.blueprints import docs as docs_mod


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app(
        {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        }
    )


def test_get_doc_rejects_traversal(app):
    """A doc name escaping the docs dir returns 400 (the Flask string
    converter blocks slashes in routing, so the guard is exercised directly)."""
    with app.test_request_context():
        body, status = docs_mod.get_doc("../../CLAUDE")
    assert status == 400
    assert body.get_json()["error"] == "Invalid doc name"


def test_list_docs_missing_dir(app, monkeypatch):
    """When the docs directory does not exist, list_docs returns an empty list."""
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    with app.test_request_context():
        resp = docs_mod.list_docs()
    assert resp.get_json() == {"docs": []}


def test_get_doc_read_failure(app, monkeypatch):
    """A read error surfaces as a 500 rather than crashing the request."""
    def boom(self, *args, **kwargs):
        raise OSError("disk gone")

    monkeypatch.setattr(pathlib.Path, "read_text", boom)
    with app.test_request_context():
        body, status = docs_mod.get_doc("api")
    assert status == 500
    assert body.get_json()["error"] == "Failed to read documentation"
