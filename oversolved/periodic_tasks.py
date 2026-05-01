"""Periodic task framework for background maintenance jobs."""

import threading
import time
from datetime import datetime, timedelta
from typing import Optional


class PeriodicTask:
    """Base class for periodic tasks."""

    def __init__(self, name: str, task_key: str, schedule: str, description: str = ""):
        self.name = name
        self.task_key = task_key
        self.schedule = schedule  # Cron expression
        self.description = description

    def run(self, db) -> dict:
        """Execute the task.

        Returns:
        {
          "status": "success" | "error",
          "duration_ms": 1234,
          "error": "Optional error message"
        }
        """
        raise NotImplementedError


def _parse_cron(cron_expr: str) -> datetime:
    """Parse a cron expression and return the next run time.

    Supports simple expressions like:
    - "0 2 * * *" (daily at 2:00 AM)
    - "0 */6 * * *" (every 6 hours)
    - "0 0 * * 0" (weekly on Sunday)
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        raise ValueError(f"Invalid cron expression: {cron_expr}")

    minute_str, hour_str, day_str, month_str, dow_str = parts
    now = datetime.now()

    # Handle "0 2 * * *" (daily at specific time)
    if day_str == "*" and month_str == "*" and dow_str == "*":
        minute = int(minute_str)
        if hour_str.startswith("*/"):
            interval = int(hour_str[2:])
            next_hour = ((now.hour // interval) + 1) * interval
            if next_hour >= 24:
                next_hour = 0
                target = now + timedelta(days=1)
            else:
                target = now
            return target.replace(hour=next_hour, minute=minute, second=0, microsecond=0)
        else:
            hour = int(hour_str)
            target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            return target

    # Fallback: next day at midnight
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


class TaskScheduler:
    """Manages periodic task execution."""

    def __init__(self, db_or_factory):
        if callable(db_or_factory):
            self._db_factory = db_or_factory
            self.db = db_or_factory()
        else:
            self._db_factory = lambda: db_or_factory
            self.db = db_or_factory
        self.tasks: dict[str, PeriodicTask] = {}
        self._next_run_at: dict[str, datetime] = {}  # Track next run times in memory
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register_task(self, task: PeriodicTask) -> None:
        """Register a periodic task."""
        self.tasks[task.task_key] = task
        self._next_run_at[task.task_key] = _parse_cron(task.schedule)

    def start(self) -> None:
        """Start the scheduler in background thread."""
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._scheduler_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the scheduler."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _scheduler_loop(self) -> None:
        """Main scheduler loop (runs in background thread)."""
        from oversolved.db import PeriodicTaskStore

        db = self._db_factory()
        try:
            task_store = PeriodicTaskStore(db)
            while not self._stop_event.is_set():
                now = datetime.now()

                # Check each task to see if it should run
                for task_key, task in self.tasks.items():
                    next_run = self._next_run_at.get(task_key)
                    if next_run is None or next_run > now:
                        continue

                    start_time = time.time()
                    try:
                        task_store.ensure_task_exists(task_key)
                        result = task.run(db)
                        task_store.update_task(task_key, {
                            "last_run_at": datetime.now().isoformat(),
                            "last_run_status": result.get("status", "success"),
                        })
                    except Exception as e:
                        task_store.update_task(task_key, {
                            "last_run_at": datetime.now().isoformat(),
                            "last_run_status": "error",
                        })

                    # Schedule next run
                    self._next_run_at[task_key] = _parse_cron(task.schedule)

                # Sleep briefly before checking again (every 30 seconds)
                self._stop_event.wait(30)
        finally:
            db.close()

    def force_run_task(self, task_key: str) -> dict:
        """Force execution of a task immediately."""
        from oversolved.db import PeriodicTaskStore

        if task_key not in self.tasks:
            return {"status": "error", "error": f"Task not found: {task_key}"}

        task = self.tasks[task_key]
        start_time = time.time()

        try:
            task_store = PeriodicTaskStore(self.db)
            task_store.ensure_task_exists(task_key)
            result = task.run(self.db)

            task_store.update_task(task_key, {
                "last_run_at": datetime.now().isoformat(),
                "last_run_status": result.get("status", "success"),
            })

            return {"status": "success", **result}
        except Exception as e:
            task_store = PeriodicTaskStore(self.db)
            task_store.ensure_task_exists(task_key)
            task_store.update_task(task_key, {
                "last_run_at": datetime.now().isoformat(),
                "last_run_status": "error",
            })
            return {
                "status": "error",
                "error": str(e)
            }


class EmptyTrashTask(PeriodicTask):
    """Delete documents permanently if they have been in trash for 30+ days."""

    def __init__(self):
        super().__init__(
            name="Empty Trash",
            task_key="document.empty_trash",
            schedule="0 2 * * *",  # Daily at 2 AM
            description="Permanently delete documents in trash for 30+ days"
        )

    def run(self, db) -> dict:
        from oversolved.db import DocumentStore

        doc_store = DocumentStore(db)
        cutoff_date = datetime.now() - timedelta(days=30)

        # Find documents deleted before cutoff
        deleted_docs = doc_store.find_deleted_before(cutoff_date)
        count = 0
        errors = []

        for doc in deleted_docs:
            try:
                doc_store.permanently_delete(doc["uuid"])
                count += 1
            except Exception as e:
                errors.append({"uuid": doc["uuid"], "error": str(e)})

        return {
            "status": "success" if not errors else "partial",
            "deleted_count": count,
            "errors": errors
        }
