"""Tests for AccountStore in oversolved.db."""

from oversolved.db import Database, SQLiteConnection, AccountStore


def _make_db():
    db = Database(SQLiteConnection(":memory:"))
    db.execute(
        """CREATE TABLE accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            handle TEXT UNIQUE NOT NULL,
            owner_type TEXT NOT NULL,
            owner_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.commit()
    return db


class TestAccountStore:
    def test_create_account(self):
        db = _make_db()
        store = AccountStore(db)
        store.register("alice", "user", 1)

        account = store.find_by_handle("alice")
        assert account is not None
        assert account["handle"] == "alice"
        assert account["owner_type"] == "user"
        assert account["owner_id"] == 1
        assert "id" in account

    def test_find_account_by_handle(self):
        db = _make_db()
        store = AccountStore(db)
        store.register("bob", "user", 2)
        store.register("carol", "org", 3)

        account = store.find_by_handle("bob")
        assert account is not None
        assert account["handle"] == "bob"

        account = store.find_by_handle("carol")
        assert account is not None
        assert account["handle"] == "carol"
        assert account["owner_type"] == "org"

    def test_find_account_not_found(self):
        db = _make_db()
        store = AccountStore(db)
        account = store.find_by_handle("nonexistent")
        assert account is None

    def test_create_duplicate_handle_raises(self):
        db = _make_db()
        store = AccountStore(db)
        store.register("alice", "user", 1)

        import pytest
        with pytest.raises(Exception):
            store.register("alice", "user", 2)
