"""Periodic task framework for background maintenance jobs."""

import logging
from datetime import datetime, timedelta, timezone
from croniter import croniter, CroniterBadCronError

logger = logging.getLogger(__name__)


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


def _cron_next(cron_expr: str, from_time: datetime) -> datetime:
    """Compute the next scheduled run time after from_time for a cron expression.

    Supports the full cron syntax via croniter, including:
    - "0 2 * * *" (daily at 2:00 AM)
    - "0 */6 * * *" (every 6 hours)
    - "0 0 * * 0" (weekly on Sunday)
    - "*/30 * * * *" (every 30 minutes)
    - "0,30 * * * *" (at :00 and :30 each hour)
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        raise ValueError(f"Invalid cron expression: {cron_expr!r}")

    try:
        # strip tzinfo for croniter; restore it afterwards
        naive = from_time.replace(tzinfo=None) if from_time.tzinfo else from_time
        it = croniter(cron_expr, naive)
        next_dt: datetime = it.get_next(datetime)
    except (CroniterBadCronError, ValueError) as exc:
        raise ValueError(f"Invalid cron expression: {cron_expr!r}") from exc

    if from_time.tzinfo is not None:
        next_dt = next_dt.replace(tzinfo=from_time.tzinfo)
    return next_dt


def _parse_cron(cron_expr: str) -> datetime:
    """Parse a cron expression and return the next run time from now.

    Supports simple expressions like:
    - "0 2 * * *" (daily at 2:00 AM)
    - "0 */6 * * *" (every 6 hours)
    - "0 0 * * 0" (weekly on Sunday)
    """
    return _cron_next(cron_expr, datetime.now(timezone.utc))


def is_task_due(last_run_at: str | None, cron_expr: str, now: datetime | None = None) -> bool:
    """Check if a task is due to run based on last_run_at and cron schedule."""
    if now is None:
        now = datetime.now(timezone.utc)
    if last_run_at is None:
        return True  # Never run
    last_run = datetime.fromisoformat(last_run_at)
    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=timezone.utc)
    next_run = _cron_next(cron_expr, last_run)
    return next_run <= now


class TaskScheduler:
    """Manages periodic task registration and execution."""

    def __init__(self):
        self.tasks: dict[str, PeriodicTask] = {}

    def register_task(self, task: PeriodicTask) -> None:
        """Register a periodic task."""
        self.tasks[task.task_key] = task

    def run_due_tasks(self, db) -> list[dict]:
        """Run all tasks that are due. Returns list of result dicts."""
        from oversolved.db import PeriodicTaskStore

        task_store = PeriodicTaskStore(db)
        results = []
        now = datetime.now(timezone.utc)

        # Snapshot all task records from DB once
        all_records = {t["task_key"]: t for t in task_store.find_all()}

        for task_key, task in self.tasks.items():
            task_store.ensure_task_exists(task_key)

            task_record = all_records.get(task_key)
            last_run_at = task_record["last_run_at"] if task_record else None

            if not is_task_due(last_run_at, task.schedule, now):
                continue

            try:
                result = task.run(db)
                task_store.update_task(task_key, {
                    "last_run_at": datetime.now(timezone.utc).isoformat(),
                    "last_run_status": result.get("status", "success"),
                })
                results.append({"task_key": task_key, "status": "success", **result})
            except Exception as e:
                task_store.update_task(task_key, {
                    "last_run_at": datetime.now(timezone.utc).isoformat(),
                    "last_run_status": "error",
                })
                results.append({"task_key": task_key, "status": "error", "error": str(e)})

        return results

    def force_run_task(self, task_key: str, db) -> dict:
        """Force execution of a task immediately."""
        from oversolved.db import PeriodicTaskStore

        if task_key not in self.tasks:
            return {"status": "error", "error": f"Task not found: {task_key}"}

        task = self.tasks[task_key]

        task_store = PeriodicTaskStore(db)
        task_store.ensure_task_exists(task_key)

        try:
            result = task.run(db)

            task_store.update_task(task_key, {
                "last_run_at": datetime.now(timezone.utc).isoformat(),
                "last_run_status": result.get("status", "success"),
            })

            return {"status": "success", **result}
        except Exception as e:
            task_store.update_task(task_key, {
                "last_run_at": datetime.now(timezone.utc).isoformat(),
                "last_run_status": "error",
            })
            return {"status": "error", "error": str(e)}


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
        cutoff_date = datetime.now(timezone.utc) - timedelta(days=30)

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
