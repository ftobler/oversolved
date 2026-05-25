"""Tests for the standalone task runner (no background thread)."""

import pytest
from datetime import datetime, timedelta, timezone
from oversolved.db import Database, PostgreSQLConnection, PeriodicTaskStore
from oversolved.periodic_tasks import (
    TaskScheduler,
    PeriodicTask,
    _cron_next,
    is_task_due,
)


class FakeTask(PeriodicTask):
    """A controllable task for testing."""

    def __init__(self, task_key="test.fake", schedule="0 2 * * *", fail=False):
        super().__init__(name=f"Fake {task_key}", task_key=task_key, schedule=schedule)
        self.fail = fail
        self.run_count = 0

    def run(self, db) -> dict:
        self.run_count += 1
        if self.fail:
            raise RuntimeError("Intentional failure")
        return {"status": "success", "deleted_count": 0, "errors": []}


def _make_db(pg_dsn):
    from oversolved.migrations import discover_and_register
    database = Database(PostgreSQLConnection(pg_dsn))
    discover_and_register(database)
    database.init()
    return database


@pytest.fixture
def db(pg_dsn):
    database = _make_db(pg_dsn)
    yield database
    database.close()


@pytest.fixture
def task_store(db):
    return PeriodicTaskStore(db)


class TestCronNext:
    def test_cron_next_daily_returns_future_time(self):
        now = datetime(2025, 6, 1, 10, 0, 0)
        result = _cron_next("0 2 * * *", now)
        assert result.hour == 2
        assert result.minute == 0
        assert result > now
        # Next 2 AM after June 1 10:00 is June 2 at 02:00
        assert result.day == 2

    def test_cron_next_daily_before_time(self):
        now = datetime(2025, 6, 1, 1, 0, 0)
        result = _cron_next("0 2 * * *", now)
        assert result.hour == 2
        assert result.minute == 0
        assert result.day == 1  # Same day, since 2 AM is still ahead

    def test_cron_next_every_six_hours(self):
        now = datetime(2025, 6, 1, 4, 0, 0)
        result = _cron_next("0 */6 * * *", now)
        assert result.hour == 6
        assert result.minute == 0

    def test_cron_next_weekly(self):
        now = datetime(2025, 6, 1, 10, 0, 0)  # Sunday
        result = _cron_next("0 2 * * 1", now)  # Monday at 2 AM
        assert result.weekday() == 0  # Monday
        assert result.hour == 2
        assert result.minute == 0

    def test_cron_next_weekly_same_day_after(self):
        now = datetime(2025, 6, 2, 10, 0, 0)  # Monday 10 AM
        result = _cron_next("0 2 * * 1", now)  # Monday 2 AM (next week)
        assert result.weekday() == 0  # Monday
        assert result > now

    def test_cron_next_daily_at_midnight_boundary(self):
        now = datetime(2025, 6, 1, 0, 0, 0)  # Exactly midnight
        result = _cron_next("0 2 * * *", now)
        assert result.hour == 2
        assert result.minute == 0
        assert result.day == 1  # Same day, 2 AM is still ahead

    def test_cron_next_month_boundary(self):
        now = datetime(2025, 12, 31, 10, 0, 0)
        result = _cron_next("0 2 * * *", now)
        assert result.month == 1  # Jan next year
        assert result.day == 1
        assert result.hour == 2

    def test_cron_next_invalid_expression(self):
        with pytest.raises(ValueError, match="Invalid cron expression"):
            _cron_next("not a cron", datetime.now())

    def test_cron_next_whitespace_handling(self):
        now = datetime(2025, 6, 1, 10, 0, 0)
        result = _cron_next("  0 2 * * *  ", now)  # Extra whitespace
        assert result.hour == 2
        assert result.minute == 0


class TestIsTaskDue:
    def test_never_run_is_due(self):
        assert is_task_due(None, "0 2 * * *") is True

    def test_recently_run_not_due(self):
        last_run = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        assert is_task_due(last_run, "0 2 * * *") is False

    def test_overdue_is_due(self):
        last_run = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        assert is_task_due(last_run, "0 2 * * *") is True


class TestTaskSchedulerEdgeCases:
    def test_empty_scheduler_returns_empty(self, db):
        scheduler = TaskScheduler()
        results = scheduler.run_due_tasks(db)
        assert results == []

    def test_scheduler_with_no_registered_tasks(self, db):
        """run_due_tasks with empty self.tasks produces no results."""
        scheduler = TaskScheduler()
        results = scheduler.run_due_tasks(db)
        assert len(results) == 0

    def test_is_task_due_with_future_last_run(self, db):
        """A task with last_run_at in the future should not be due."""
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        assert is_task_due(future, "0 2 * * *") is False

    def test_is_task_due_at_exact_time(self, db):
        """A task last_run_at exactly at the cron time (within 1min) is not due."""
        now = datetime.now(timezone.utc)
        # If now matches cron (2:00), last_run at 2:00 means not due yet
        near_now = now.replace(hour=2, minute=0, second=0, microsecond=0)
        if near_now > now:
            near_now = near_now - timedelta(days=1)
        last_run = near_now.isoformat()
        assert is_task_due(last_run, "0 2 * * *") is False


class TestRunDueTasks:
    def test_run_due_tasks_executes_never_run_task(self, db, task_store):
        scheduler = TaskScheduler()
        task = FakeTask()
        scheduler.register_task(task)

        results = scheduler.run_due_tasks(db)

        assert len(results) == 1
        assert results[0]["task_key"] == "test.fake"
        assert results[0]["status"] == "success"

        tasks = task_store.find_all()
        t = next(t for t in tasks if t["task_key"] == "test.fake")
        assert t["last_run_status"] == "success"
        assert t["last_run_at"] is not None

    def test_run_due_tasks_skips_recently_run_task(self, db, task_store):
        db.execute(
            "INSERT INTO periodic_tasks (task_key, last_run_at, last_run_status) VALUES (?, ?, ?)",
            ("test.fake", (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), "success"),
        )
        db.commit()

        scheduler = TaskScheduler()
        task = FakeTask()
        scheduler.register_task(task)

        results = scheduler.run_due_tasks(db)

        assert len(results) == 0
        assert task.run_count == 0

    def test_run_due_tasks_executes_overdue_task(self, db, task_store):
        db.execute(
            "INSERT INTO periodic_tasks (task_key, last_run_at, last_run_status) VALUES (?, ?, ?)",
            ("test.fake", (datetime.now(timezone.utc) - timedelta(days=2)).isoformat(), "success"),
        )
        db.commit()

        scheduler = TaskScheduler()
        task = FakeTask()
        scheduler.register_task(task)

        results = scheduler.run_due_tasks(db)

        assert len(results) == 1
        assert results[0]["task_key"] == "test.fake"
        assert results[0]["status"] == "success"

    def test_run_due_tasks_multiple_tasks(self, db, task_store):
        scheduler = TaskScheduler()
        task_a = FakeTask(task_key="test.a", schedule="0 2 * * *")
        task_b = FakeTask(task_key="test.b", schedule="0 3 * * *")
        scheduler.register_task(task_a)
        scheduler.register_task(task_b)

        results = scheduler.run_due_tasks(db)

        assert len(results) == 2
        keys = [r["task_key"] for r in results]
        assert "test.a" in keys
        assert "test.b" in keys

    def test_run_due_tasks_one_fails(self, db, task_store):
        scheduler = TaskScheduler()
        good_task = FakeTask(task_key="test.good")
        bad_task = FakeTask(task_key="test.bad", fail=True)
        scheduler.register_task(good_task)
        scheduler.register_task(bad_task)

        results = scheduler.run_due_tasks(db)

        assert len(results) == 2
        good_result = next(r for r in results if r["task_key"] == "test.good")
        bad_result = next(r for r in results if r["task_key"] == "test.bad")
        assert good_result["status"] == "success"
        assert bad_result["status"] == "error"

        # Both should have a last_run_at timestamp
        tasks = task_store.find_all()
        for t in tasks:
            assert t["last_run_at"] is not None


class TestForceTask:
    def test_force_task_from_cli(self, db, task_store):
        scheduler = TaskScheduler()
        task = FakeTask()
        scheduler.register_task(task)

        result = scheduler.force_run_task("test.fake", db)

        assert result["status"] == "success"

        tasks = task_store.find_all()
        t = next(t for t in tasks if t["task_key"] == "test.fake")
        assert t["last_run_status"] == "success"
        assert t["last_run_at"] is not None

    def test_force_task_unknown(self, db):
        scheduler = TaskScheduler()
        result = scheduler.force_run_task("nonexistent", db)
        assert result["status"] == "error"


class TestCliArgs:
    def test_cli_entry_parse_args(self):
        from oversolved.cli import build_parser

        parser = build_parser()

        # Test run_server subcommand
        args = parser.parse_args(["run_server", "--host", "0.0.0.0", "--port", "8080"])
        assert args.command == "run_server"
        assert args.host == "0.0.0.0"
        assert args.port == 8080

        # Test run_tasks subcommand
        args = parser.parse_args(["run_tasks", "--loop", "--interval", "30"])
        assert args.command == "run_tasks"
        assert args.loop is True
        assert args.interval == 30

        # Test run_tasks with force-task
        args = parser.parse_args(["run_tasks", "--force-task", "document.empty_trash"])
        assert args.command == "run_tasks"
        assert args.force_task == "document.empty_trash"
