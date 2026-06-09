"""Unit tests for RebuildTimeStore."""

from oversolved.db import Database, SQLiteConnection, RebuildTimeStore


def _make_db() -> Database:
    db = Database(SQLiteConnection(":memory:"))
    db.execute(
        """CREATE TABLE rebuild_times (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_uuid TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            feature_count INTEGER NOT NULL DEFAULT 0
        )"""
    )
    db.commit()
    return db


class TestRebuildTimeStore:

    def test_record_inserts_row(self):
        db = _make_db()
        store = RebuildTimeStore(db)
        store.record("doc-1", 150, 3)
        cursor = db.execute(
            "SELECT document_uuid, duration_ms, feature_count FROM rebuild_times"
        )
        rows = cursor.fetchall()
        assert len(rows) == 1
        assert rows[0][0] == "doc-1"
        assert rows[0][1] == 150
        assert rows[0][2] == 3

    def test_compute_stats_empty_returns_zeros(self):
        db = _make_db()
        store = RebuildTimeStore(db)
        stats = store.compute_stats("no-doc")
        assert stats["rebuild_count"] == 0
        assert stats["last_duration_ms"] is None
        assert stats["average_ms"] is None
        assert stats["median_ms"] is None
        assert stats["min_ms"] is None
        assert stats["max_ms"] is None
        assert stats["trend"] is None
        assert stats["history"] == []

    def test_compute_stats_trend_faster_when_recent_lower(self):
        """Recent rebuilds much faster than older ones gives trend='faster'."""
        db = _make_db()
        store = RebuildTimeStore(db)
        # Insert oldest first (lower ids = older), newest last (higher ids = more recent)
        for duration in [1000, 950, 900, 850, 800, 100, 90, 80, 70, 60]:
            store.record("doc-trend", duration, 1)
        stats = store.compute_stats("doc-trend")
        assert stats["trend"] == "faster"

    def test_compute_stats_trend_slower_when_recent_higher(self):
        """Recent rebuilds much slower than older ones gives trend='slower'."""
        db = _make_db()
        store = RebuildTimeStore(db)
        for duration in [100, 110, 120, 130, 140, 800, 850, 900, 950, 1000]:
            store.record("doc-slow", duration, 1)
        stats = store.compute_stats("doc-slow")
        assert stats["trend"] == "slower"

    def test_history_returns_newest_first(self):
        db = _make_db()
        store = RebuildTimeStore(db)
        for d in [10, 20, 30]:
            store.record("doc-h", d, 1)
        h = store.history("doc-h", limit=20)
        assert h[0] == 30  # most recent first
        assert h[-1] == 10

    def test_history_respects_limit(self):
        db = _make_db()
        store = RebuildTimeStore(db)
        for d in range(25):
            store.record("doc-lim", d, 1)
        h = store.history("doc-lim", limit=20)
        assert len(h) == 20
