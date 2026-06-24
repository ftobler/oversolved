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


def _seed(db: Database, doc_id: str, durations: list[int]) -> None:
    """Insert rebuild timing rows for testing."""
    for d in durations:
        db.execute(
            "INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count) VALUES (?, ?, 1)",
            (doc_id, d),
        )
    db.commit()


class TestRebuildTimeStore:

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
        _seed(db, "doc-trend", [1000, 950, 900, 850, 800, 100, 90, 80, 70, 60])
        stats = store.compute_stats("doc-trend")
        assert stats["trend"] == "faster"

    def test_compute_stats_trend_slower_when_recent_higher(self):
        """Recent rebuilds much slower than older ones gives trend='slower'."""
        db = _make_db()
        store = RebuildTimeStore(db)
        _seed(db, "doc-slow", [100, 110, 120, 130, 140, 800, 850, 900, 950, 1000])
        stats = store.compute_stats("doc-slow")
        assert stats["trend"] == "slower"

    def test_compute_stats_single_record(self):
        """One record: odd-count median equals the value and trend stays None."""
        db = _make_db()
        store = RebuildTimeStore(db)
        _seed(db, "doc-one", [175])
        stats = store.compute_stats("doc-one")
        assert stats["rebuild_count"] == 1
        assert stats["last_duration_ms"] == 175
        assert stats["median_ms"] == 175.0
        assert stats["min_ms"] == 175
        assert stats["max_ms"] == 175
        assert stats["trend"] is None

    def test_compute_stats_trend_stable_when_similar(self):
        """Recent and older averages within 10 percent gives trend='stable'."""
        db = _make_db()
        store = RebuildTimeStore(db)
        _seed(db, "doc-stable", [100, 101, 99, 100, 102, 98, 100, 101, 99, 100])
        stats = store.compute_stats("doc-stable")
        assert stats["trend"] == "stable"
