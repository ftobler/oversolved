"""Rebuild time tracking store."""

from oversolved.db.migrations import Database


class RebuildTimeStore:
    """Record and query document rebuild timings."""

    def __init__(self, db: Database):
        self.db = db

    def record(self, doc_id: str, duration_ms: int, feature_count: int) -> None:
        """Insert one rebuild timing row."""
        try:
            self.db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, duration_ms, feature_count),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def history(self, doc_id: str, limit: int = 20) -> list[int]:
        """Return the most recent rebuild durations (newest first)."""
        cursor = self.db.execute(
            """SELECT duration_ms FROM rebuild_times
               WHERE document_uuid = ?
               ORDER BY id DESC
               LIMIT ?""",
            (doc_id, limit),
        )
        return [row[0] for row in cursor.fetchall()]

    def compute_stats(self, doc_id: str) -> dict:
        """Compute aggregate rebuild statistics for a document."""
        cursor = self.db.execute(
            """SELECT duration_ms FROM rebuild_times
               WHERE document_uuid = ?
               ORDER BY id DESC""",
            (doc_id,),
        )
        rows = cursor.fetchall()
        if not rows:
            return {
                "rebuild_count": 0,
                "last_duration_ms": None,
                "average_ms": None,
                "median_ms": None,
                "min_ms": None,
                "max_ms": None,
                "trend": None,
                "history": [],
            }

        all_durations = [r[0] for r in rows]
        count = len(all_durations)
        last_ms = all_durations[0]
        avg_ms = sum(all_durations) / count
        sorted_d = sorted(all_durations)
        n = count
        if n % 2 == 1:
            median_ms: float = float(sorted_d[n // 2])
        else:
            median_ms = (sorted_d[n // 2 - 1] + sorted_d[n // 2]) / 2.0
        min_ms = sorted_d[0]
        max_ms = sorted_d[-1]

        trend: str | None
        if count >= 2:
            recent = all_durations[:5]
            older = all_durations[-5:] if count >= 5 else all_durations[1:]
            recent_avg = sum(recent) / len(recent)
            older_avg = sum(older) / len(older)
            if recent_avg < older_avg * 0.9:
                trend = "faster"
            elif recent_avg > older_avg * 1.1:
                trend = "slower"
            else:
                trend = "stable"
        else:
            trend = None

        history = all_durations[:20]

        return {
            "rebuild_count": count,
            "last_duration_ms": last_ms,
            "average_ms": avg_ms,
            "median_ms": median_ms,
            "min_ms": min_ms,
            "max_ms": max_ms,
            "trend": trend,
            "history": history,
        }
