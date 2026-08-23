"""Tests for POST /api/documents/import and DocumentStore.import_document.

The import route used to create the row and store the content in two separate
committing calls, so a failure between them left a committed empty-content
document behind. These tests pin the atomic behaviour.
"""

import json

import pytest

from oversolved.db import DocumentStore

from .dbutil import make_db


def _import(client, payload):
    return client.post(
        "/api/documents/import",
        data=json.dumps(payload),
        content_type="application/json",
    )


def test_import_creates_document_with_content(authed_client):
    """The happy path returns 201 and the content is readable straight back."""
    resp = _import(authed_client, {"name": "imported", "content": "features: []\n"})
    assert resp.status_code == 201
    body = resp.get_json()
    assert body["name"] == "imported"

    fetched = authed_client.get(f"/api/documents/{body['uuid']}")
    assert fetched.status_code == 200
    assert fetched.get_json()["content"] == "features: []\n"


def test_import_requires_a_name(authed_client):
    """A blank name is rejected before anything is written."""
    resp = _import(authed_client, {"name": "   ", "content": "x"})
    assert resp.status_code == 400


def test_import_defaults_missing_content_to_empty(authed_client):
    """A missing content field still produces a valid document."""
    resp = _import(authed_client, {"name": "no-content"})
    assert resp.status_code == 201
    uuid = resp.get_json()["uuid"]
    assert authed_client.get(f"/api/documents/{uuid}").get_json()["content"] == ""


def test_import_rejects_dict_content(authed_client):
    """Structured content must 400 instead of erroring in psycopg2 or later."""
    resp = _import(authed_client, {"name": "dict-content", "content": {"features": []}})
    assert resp.status_code == 400
    assert resp.get_json()["code"] == "BAD_REQUEST"


def test_import_rejects_numeric_content(authed_client):
    """A numeric content payload must not be silently stringified into the row."""
    resp = _import(authed_client, {"name": "numeric-content", "content": 5})
    assert resp.status_code == 400


def test_import_never_commits_an_empty_content_row(authed_client, pg_dsn, monkeypatch):
    """A failing content write must not leave a half-imported document behind.

    store_content is sabotaged to stand in for any mid-import failure. The
    atomic route no longer calls it, so the import succeeds; the pre-fix route
    committed the empty row first and only then failed.
    """
    def _boom(self, uuid, content):
        raise RuntimeError("content write failed")

    monkeypatch.setattr(DocumentStore, "store_content", _boom)

    try:
        _import(authed_client, {"name": "atomic", "content": "features: []\n"})
    except RuntimeError:
        pass  # the pre-fix route surfaces the sabotage; the row check below is the assertion

    db = make_db(pg_dsn)
    try:
        cursor = db.execute("SELECT name, content FROM documents")
        rows = [(row[0], row[1]) for row in cursor.fetchall()]
    finally:
        db.close()
    assert [name for name, content in rows if content == ""] == []


def test_import_document_rolls_back_on_failure(doc_store, db):
    """A rejected insert (unknown owner) leaves no row at all."""
    with pytest.raises(Exception):
        doc_store.import_document("orphan", 999999, "content")

    cursor = db.execute("SELECT COUNT(*) FROM documents")
    assert cursor.fetchone()[0] == 0
