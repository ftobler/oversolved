"""Periodic task store implementation."""

from oversolved.db.migrations import Database


class PeriodicTaskStore:
    """Database accessor for tracking system task execution."""

    def __init__(self, db: Database):
        self.db = db

    def find_all(self) -> list[dict]:
        """Get all periodic tasks."""
        cursor = self.db.execute(
            """SELECT id, task_key, last_run_at, last_run_status
               FROM periodic_tasks
               ORDER BY task_key"""
        )
        return [
            {
                "id": row[0],
                "task_key": row[1],
                "last_run_at": row[2],
                "last_run_status": row[3],
            }
            for row in cursor.fetchall()
        ]

    def update_task(self, task_key: str, updates: dict) -> None:
        """Update task execution tracking."""
        allowed = {"last_run_at", "last_run_status"}
        filtered = {k: v for k, v in updates.items() if k in allowed}
        if not filtered:
            return
        set_clause = ", ".join(f"{k} = ?" for k in filtered)
        values = list(filtered.values()) + [task_key]
        with self.db.transaction():
            self.db.execute(
                f"UPDATE periodic_tasks SET {set_clause} WHERE task_key = ?",
                tuple(values),
            )

    def ensure_task_exists(self, task_key: str) -> None:
        """Ensure a task record exists, creating if needed."""
        cursor = self.db.execute(
            "SELECT id FROM periodic_tasks WHERE task_key = ?",
            (task_key,),
        )
        if cursor.fetchone() is None:
            with self.db.transaction():
                self.db.execute(
                    "INSERT INTO periodic_tasks (task_key) VALUES (?)",
                    (task_key,),
                )
