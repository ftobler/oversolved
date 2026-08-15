"""Tests for the admin backup document pager.

The pager walks the documents table with LIMIT/OFFSET, so its ORDER BY must be a
total order. Without a tiebreaker, documents sharing an owner and a name can be
repeated or skipped between pages.
"""

from oversolved.blueprints.admin import _iter_documents_page


def _insert_doc(db, uuid, name, owner_id):
    db.execute(
        "INSERT INTO documents (uuid, name, content, owner_id, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (uuid, name, "content", owner_id, "2026-01-01", "2026-01-01"),
    )


def test_pager_orders_same_named_documents_by_uuid(db, user_store):
    """Equal owner and name rows come out uuid-ascending, not in insert order."""
    owner_id = user_store.create("backupowner", "hashed_pw")
    for uuid in ["e5", "d4", "c3", "b2", "a1"]:
        _insert_doc(db, uuid, "same-name", owner_id)
    db.commit()

    uuids = [row[0] for row in _iter_documents_page(db, page_size=2)]
    assert uuids == ["a1", "b2", "c3", "d4", "e5"]


def test_pager_yields_every_document_exactly_once(db, user_store):
    """Paging over a tied name set must neither duplicate nor drop rows."""
    owner_id = user_store.create("pageowner", "hashed_pw")
    expected = {f"uuid{i}" for i in range(7)}
    for uuid in expected:
        _insert_doc(db, uuid, "tied", owner_id)
    db.commit()

    uuids = [row[0] for row in _iter_documents_page(db, page_size=3)]
    assert len(uuids) == len(expected)
    assert set(uuids) == expected


def test_pager_skips_deleted_documents(db, user_store):
    """Soft-deleted documents are not part of a backup."""
    owner_id = user_store.create("trashowner", "hashed_pw")
    _insert_doc(db, "live", "kept", owner_id)
    _insert_doc(db, "gone", "dropped", owner_id)
    db.execute("UPDATE documents SET deleted_at = ? WHERE uuid = ?", ("2026-01-02", "gone"))
    db.commit()

    uuids = [row[0] for row in _iter_documents_page(db)]
    assert uuids == ["live"]
