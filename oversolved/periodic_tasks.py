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

    def __init__(self, db_connection):
        self.db = db_connection
        self.tasks: dict[str, PeriodicTask] = {}
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def register_task(self, task: PeriodicTask) -> None:
        """Register a periodic task."""
        self.tasks[task.task_key] = task

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

        while not self._stop_event.is_set():
            now = datetime.now()

            # Find tasks that should run
            task_store = PeriodicTaskStore(self.db)
            due_tasks = task_store.find_due_tasks(now)

            for task_config in due_tasks:
                task_key = task_config["task_key"]
                if task_key not in self.tasks:
                    continue

                task = self.tasks[task_key]
                start_time = time.time()

                try:
                    result = task.run(self.db)
                    duration_ms = int((time.time() - start_time) * 1000)
                    task_store.update_task(task_key, {
                        "last_run_at": datetime.now().isoformat(),
                        "last_run_duration_ms": duration_ms,
                        "last_run_status": result.get("status", "success"),
                        "last_run_error": result.get("error"),
                        "next_run_at": _parse_cron(task_config["schedule"]).isoformat(),
                    })
                except Exception as e:
                    duration_ms = int((time.time() - start_time) * 1000)
                    task_store.update_task(task_key, {
                        "last_run_at": datetime.now().isoformat(),
                        "last_run_duration_ms": duration_ms,
                        "last_run_status": "error",
                        "last_run_error": str(e),
                        "next_run_at": _parse_cron(task_config["schedule"]).isoformat(),
                    })

            # Sleep briefly before checking again (every 30 seconds)
            self._stop_event.wait(30)

    def force_run_task(self, task_key: str) -> dict:
        """Force execution of a task immediately."""
        from oversolved.db import PeriodicTaskStore

        if task_key not in self.tasks:
            return {"status": "error", "error": f"Task not found: {task_key}"}

        task = self.tasks[task_key]
        start_time = time.time()

        try:
            result = task.run(self.db)
            duration_ms = int((time.time() - start_time) * 1000)

            task_store = PeriodicTaskStore(self.db)
            task_config = task_store.find_by_task_key(task_key)
            schedule = task_config["schedule"] if task_config else task.schedule

            task_store.update_task(task_key, {
                "last_run_at": datetime.now().isoformat(),
                "last_run_duration_ms": duration_ms,
                "last_run_status": result.get("status", "success"),
                "last_run_error": result.get("error"),
                "next_run_at": _parse_cron(schedule).isoformat(),
            })

            return {
                "status": "success",
                "duration_ms": duration_ms,
                **result
            }
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            return {
                "status": "error",
                "duration_ms": duration_ms,
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
