"""Tests for periodic task scheduler and cron expression handling."""

from datetime import datetime, timedelta, timezone
import pytest
from oversolved.db import Database, SQLiteConnection
from oversolved.periodic_tasks import _cron_next, EmptyTrashTask


class TestCronNext:
    """Tests for the _cron_next function edge cases."""

    def test_cron_next_monthly(self):
        """@monthly is not a 5-field expression, should raise ValueError."""
        from_time = datetime(2025, 6, 15, 10, 30, 0)
        with pytest.raises(ValueError):
            _cron_next("@monthly", from_time)

    def test_cron_next_day_of_month(self):
        """0 0 15 * * (15th day of month) is unhandled, falls to tomorrow midnight."""
        from_time = datetime(2025, 6, 10, 10, 30, 0)
        result = _cron_next("0 0 15 * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected

    def test_cron_next_invalid_expression(self):
        """Invalid cron expressions should raise ValueError."""
        from_time = datetime(2025, 6, 15, 10, 30, 0)

        with pytest.raises(ValueError):
            _cron_next("", from_time)

        with pytest.raises(ValueError):
            _cron_next("0 2", from_time)

        with pytest.raises(ValueError):
            _cron_next("0 2 * * * *", from_time)

    def test_cron_next_midnight_edge(self):
        """Daily at midnight near boundaries should handle correctly."""
        from_time = datetime(2025, 6, 15, 23, 59, 0)
        result = _cron_next("0 0 * * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected

        from_time = datetime(2025, 6, 15, 0, 0, 0)
        result = _cron_next("0 0 * * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected


class TestEmptyTrashTask:
    """Tests for EmptyTrashTask.run()."""

    def _make_db(self):
        db = Database(SQLiteConnection(":memory:"))
        db.execute(
            """CREATE TABLE documents (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                deleted_at TEXT
            )"""
        )
        db.commit()
        return db

    def test_deletes_expired_documents(self):
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=31)
        deleted_at_str = cutoff.isoformat()

        db = self._make_db()
        db.execute(
            "INSERT INTO documents (uuid, name, content, owner_id, created_at, updated_at, deleted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("doc-old", "old doc", "", 1, deleted_at_str, deleted_at_str, deleted_at_str),
        )
        db.execute(
            "INSERT INTO documents (uuid, name, content, owner_id, created_at, updated_at, deleted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("doc-kept", "kept doc", "", 1, now.isoformat(), now.isoformat(), None),
        )
        db.commit()

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 1

        cursor = db.execute("SELECT uuid FROM documents WHERE uuid = ?", ("doc-old",))
        assert cursor.fetchone() is None, "old document should be permanently deleted"

        cursor = db.execute("SELECT uuid FROM documents WHERE uuid = ?", ("doc-kept",))
        assert cursor.fetchone() is not None, "non-deleted document should remain"

    def test_preserves_recently_deleted_documents(self):
        now = datetime.now(timezone.utc)
        recent = now - timedelta(days=29)
        deleted_at_str = recent.isoformat()

        db = self._make_db()
        db.execute(
            "INSERT INTO documents (uuid, name, content, owner_id, created_at, updated_at, deleted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("doc-recent", "recently deleted", "", 1, deleted_at_str, deleted_at_str, deleted_at_str),
        )
        db.commit()

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 0

        cursor = db.execute("SELECT uuid FROM documents WHERE uuid = ?", ("doc-recent",))
        assert cursor.fetchone() is not None, "recently deleted document should be kept"
