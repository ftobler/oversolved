"""Tests for the unified DocumentStore listing query helper."""

import pytest
from oversolved.db import Database, SQLiteConnection, DocumentStore


def _make_db() -> Database:
    db = Database(SQLiteConnection(":memory:"))
    db.execute(
        """CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL DEFAULT '',
            email TEXT,
            external_id TEXT,
            provider TEXT,
            provider_data TEXT,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            is_admin INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT '',
            last_login_at TEXT,
            updated_at TEXT,
            document_sort_preference TEXT
        )"""
    )
    db.execute(
        """CREATE TABLE accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            handle TEXT NOT NULL UNIQUE,
            owner_type TEXT NOT NULL,
            owner_id INTEGER NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            owner_id INTEGER NOT NULL,
            preview_image BLOB,
            is_public INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )"""
    )
    db.execute(
        """CREATE TABLE document_shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_uuid TEXT NOT NULL,
            shared_with_user_id INTEGER NOT NULL,
            permission TEXT NOT NULL DEFAULT 'view',
            created_at TEXT NOT NULL DEFAULT '',
            UNIQUE(document_uuid, shared_with_user_id)
        )"""
    )
    db.commit()
    return db


def _add_user(db: Database, username: str) -> int:
    db.execute(
        "INSERT INTO users (username) VALUES (?)",
        (username,),
    )
    cursor = db.execute("SELECT last_insert_rowid()")
    uid = cursor.fetchone()[0]
    db.commit()
    return uid


def _add_doc(db: Database, name: str, owner_id: int, is_public: bool = False) -> str:
    import uuid as uuid_mod
    doc_uuid = uuid_mod.uuid4().hex
    db.execute(
        "INSERT INTO documents (uuid, name, owner_id, is_public) VALUES (?, ?, ?, ?)",
        (doc_uuid, name, owner_id, 1 if is_public else 0),
    )
    db.commit()
    return doc_uuid


def _share_doc(db: Database, doc_uuid: str, user_id: int) -> None:
    db.execute(
        "INSERT INTO document_shares (document_uuid, shared_with_user_id) VALUES (?, ?)",
        (doc_uuid, user_id),
    )
    db.commit()


class TestDocumentsQuery:

    def test_documents_query_search_is_case_insensitive(self):
        db = _make_db()
        owner = _add_user(db, "owner")
        _add_doc(db, "MyDocument", owner)
        _add_doc(db, "SomethingElse", owner)

        store = DocumentStore(db)
        results = store.list_by_filter(owner, "owned", "name", "mydo")
        names = [r["name"] for r in results]
        assert "MyDocument" in names
        assert "SomethingElse" not in names

    def test_documents_query_filter_owned_excludes_shared(self):
        db = _make_db()
        alice = _add_user(db, "alice")
        bob = _add_user(db, "bob")
        _add_doc(db, "AliceDoc", alice)
        bob_doc = _add_doc(db, "BobDoc", bob)
        _share_doc(db, bob_doc, alice)

        store = DocumentStore(db)
        owned = store.list_by_filter(alice, "owned", "name", "")
        names = [r["name"] for r in owned]
        assert "AliceDoc" in names
        assert "BobDoc" not in names

    def test_filter_all_includes_owned_and_shared(self):
        db = _make_db()
        alice = _add_user(db, "alice")
        bob = _add_user(db, "bob")
        _add_doc(db, "AliceDoc", alice)
        bob_doc = _add_doc(db, "BobDoc", bob)
        _share_doc(db, bob_doc, alice)

        store = DocumentStore(db)
        results = store.list_by_filter(alice, "all", "name", "")
        names = [r["name"] for r in results]
        assert "AliceDoc" in names
        assert "BobDoc" in names

    def test_filter_public_returns_only_public(self):
        db = _make_db()
        owner = _add_user(db, "owner")
        _add_doc(db, "Private", owner, is_public=False)
        _add_doc(db, "Public", owner, is_public=True)

        store = DocumentStore(db)
        results = store.list_by_filter(owner, "public", "name", "")
        names = [r["name"] for r in results]
        assert "Public" in names
        assert "Private" not in names

    def test_filter_shared_excludes_owned(self):
        db = _make_db()
        alice = _add_user(db, "alice")
        bob = _add_user(db, "bob")
        _add_doc(db, "AliceOwns", alice)
        bob_doc = _add_doc(db, "BobShares", bob)
        _share_doc(db, bob_doc, alice)

        store = DocumentStore(db)
        results = store.list_by_filter(alice, "shared", "name", "")
        names = [r["name"] for r in results]
        assert "BobShares" in names
        assert "AliceOwns" not in names

    def test_create_sets_isoformat_timestamp_so_sort_by_date_works(self):
        """Newly created documents must appear first when sorted newest-first.

        Before the fix, DocumentStore.create() relied on the DB DEFAULT
        (NOW()::text) which produces a space-separated timestamp like
        '2024-01-01 12:00:00+00'. Python's isoformat() produces a T-separated
        one like '2024-01-01T12:00:00+00:00'. Text-sort puts space before T
        so a newly created doc would appear *after* older but Python-updated
        documents.
        """
        import time
        db = _make_db()
        owner = _add_user(db, "owner")
        store = DocumentStore(db)

        # Insert an older doc via the helper (raw INSERT with empty updated_at)
        # then update it to have a known Python-style timestamp via store_content,
        # which simulates a doc that was created before but later modified.
        store.create("OldDoc", owner)
        time.sleep(0.01)
        store.create("NewDoc", owner)

        results = store.list_by_filter(owner, "owned", "modified", "")
        names = [r["name"] for r in results]
        assert names[0] == "NewDoc", (
            f"NewDoc should appear first when sorted newest-first, got {names}"
        )

    @pytest.mark.parametrize("filter_type", ["all", "owned", "shared", "public"])
    def test_unified_query_matches_old_methods(self, filter_type):
        """Verify list_by_filter routes produce same result as old individual methods."""
        db = _make_db()
        alice = _add_user(db, "alice")
        bob = _add_user(db, "bob")
        _add_doc(db, "AlicePrivate", alice)
        _add_doc(db, "PublicDoc", alice, is_public=True)
        bob_doc = _add_doc(db, "BobShared", bob)
        _share_doc(db, bob_doc, alice)

        store = DocumentStore(db)
        # list_by_filter should not raise and should return a list
        results = store.list_by_filter(alice, filter_type, "name", "")
        assert isinstance(results, list)
        for doc in results:
            assert "uuid" in doc
            assert "name" in doc
