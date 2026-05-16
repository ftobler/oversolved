"""Unit tests for UserStore row deduplication helpers."""

import pytest
from oversolved.db import Database, SQLiteConnection, UserStore
from oversolved.db.users import _AUTH_COLUMNS, _FULL_COLUMNS, _row_to_user


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
    db.commit()
    return db


class TestRowMapper:

    def test_row_mapper_handles_bool_coercion(self):
        """must_change_password, is_admin, is_active stored as int must come out as bool."""
        # Simulate a row with integer values for bool columns
        row = (1, "bob", "hash", "bob@example.com", None, None,
               1, 0, 1, None, None)  # must_change_password=1, is_admin=0, is_active=1
        result = _row_to_user(row, _AUTH_COLUMNS)
        assert result["must_change_password"] is True
        assert result["is_admin"] is False
        assert result["is_active"] is True

    def test_find_by_username_returns_full_keys(self):
        db = _make_db()
        store = UserStore(db)
        store.create("alice", "hashed", must_change_password=False)
        user = store.find_by_username("alice")
        assert user is not None
        for key in _AUTH_COLUMNS:
            assert key in user, f"Missing key: {key}"

    def test_find_by_id_returns_document_sort_preference(self):
        db = _make_db()
        store = UserStore(db)
        uid = store.create("carol", "hashed")
        user = store.find_by_id(uid)
        assert user is not None
        assert "document_sort_preference" in user
        # Default None in DB should be coerced to "alphabetical"
        assert user["document_sort_preference"] == "alphabetical"

    def test_find_by_id_returns_full_columns(self):
        db = _make_db()
        store = UserStore(db)
        uid = store.create("dave", "hashed", email="dave@example.com")
        user = store.find_by_id(uid)
        assert user is not None
        for key in _FULL_COLUMNS:
            assert key in user, f"Missing key: {key}"
        # find_by_id does not expose password_hash
        assert "password_hash" not in user

    def test_find_by_username_missing_returns_none(self):
        db = _make_db()
        store = UserStore(db)
        assert store.find_by_username("nobody") is None
