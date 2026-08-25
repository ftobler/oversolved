"""Tests for POST /api/admin/import-backup document restore behaviour.

The restore path used to create the row and store the content in two separate
committing calls, so a failure between them left a committed empty-content
document behind. It now reuses DocumentStore.import_document for the atomic
insert, like the per-document import route always did.
"""

import io
import json
import zipfile

from oversolved.db import DocumentStore

from .dbutil import make_db


def _zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    buf.seek(0)
    return buf


def test_failed_content_write_leaves_no_orphan_row(authed_client, pg_dsn, monkeypatch):
    """A mid-import failure must not leave a committed empty-content document.

    store_content is sabotaged like the documents-import twin test: the restore
    path inserts content atomically via import_document and never calls it, so
    the import succeeds; the pre-fix create()/store_content() pair committed the
    empty row first and only then failed.
    """
    def _boom(self, uuid, content):
        raise RuntimeError("content write failed")

    monkeypatch.setattr(DocumentStore, "store_content", _boom)

    payload = _zip_bytes([("admin/orphan_check.yaml", "name: orphan\n")])
    resp = authed_client.post(
        "/api/admin/import-backup",
        data={"file": (payload, "backup.zip")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    body = json.loads(resp.data)
    assert body["imported_count"] == 1

    db = make_db(pg_dsn)
    try:
        cursor = db.execute("SELECT COUNT(*) FROM documents WHERE content = ''")
        assert cursor.fetchone()[0] == 0
    finally:
        db.close()
