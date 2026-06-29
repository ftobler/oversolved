"""Tests for the standalone task runner (no background thread)."""

import argparse
import pytest
from datetime import datetime, timedelta, timezone
from oversolved.cli import _positive_int, _validate_db_args, build_parser
from oversolved.db import PeriodicTaskStore
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
        now = datetime(2025, 6, 1, 10, 0, 0, tzinfo=timezone.utc)
        last_run = (now - timedelta(hours=1)).isoformat()
        assert is_task_due(last_run, "0 2 * * *", now) is False

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

    def test_run_due_tasks_skips_recently_run_task(self, db, task_store, monkeypatch):
        import oversolved.periodic_tasks as pt
        frozen_now = datetime(2025, 6, 1, 10, 0, 0, tzinfo=timezone.utc)

        class FakeDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now

        monkeypatch.setattr(pt, "datetime", FakeDatetime)

        db.execute(
            "INSERT INTO periodic_tasks (task_key, last_run_at, last_run_status) VALUES (?, ?, ?)",
            ("test.fake", (frozen_now - timedelta(hours=1)).isoformat(), "success"),
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

    def test_force_task_failure_records_error(self, db, task_store):
        """A task that raises during force_run is reported and recorded as error."""
        scheduler = TaskScheduler()
        scheduler.register_task(FakeTask(task_key="test.fail", fail=True))

        result = scheduler.force_run_task("test.fail", db)
        assert result["status"] == "error"
        assert "Intentional failure" in result["error"]

        rec = next(t for t in task_store.find_all() if t["task_key"] == "test.fail")
        assert rec["last_run_status"] == "error"
        assert rec["last_run_at"] is not None


class TestPeriodicTaskBranches:
    """Cover small, otherwise-unexercised branches of the periodic framework."""

    def test_base_run_not_implemented(self):
        """The abstract-ish base run() must signal it has no implementation."""
        task = PeriodicTask(name="Base", task_key="base", schedule="0 2 * * *")
        with pytest.raises(NotImplementedError):
            task.run(None)  # type: ignore[arg-type]

    def test_cron_next_five_parts_but_invalid_values(self):
        """A 5-field expression with out-of-range values is rejected by croniter."""
        with pytest.raises(ValueError, match="Invalid cron expression"):
            _cron_next("99 99 99 99 99", datetime(2025, 6, 1, 10, 0, 0))

    def test_is_task_due_naive_last_run_treated_as_utc(self):
        """A naive last_run_at string is interpreted as UTC rather than crashing."""
        naive = (
            datetime.now(timezone.utc) - timedelta(days=2)
        ).replace(tzinfo=None).isoformat()
        assert is_task_due(naive, "0 2 * * *") is True


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


class TestRunTasksClosesDbOnce:
    """run_tasks must close its DB exactly once on every path (no double-close)."""

    def _run(self, monkeypatch, args):
        from oversolved import cli
        closes = {"n": 0}

        class FakeDb:
            def close(self):
                closes["n"] += 1

        monkeypatch.setattr(cli, "_get_db_from_config", lambda a, init_db=True: FakeDb())
        monkeypatch.setattr(
            "oversolved.periodic_tasks.TaskScheduler.run_due_tasks",
            lambda self, db: [],
        )
        cli.run_tasks(args)
        return closes["n"]

    def test_single_run_closes_once(self, monkeypatch):
        args = argparse.Namespace(force_task=None, loop=False)
        assert self._run(monkeypatch, args) == 1

    def test_force_task_closes_once(self, monkeypatch):
        from oversolved import cli
        closes = {"n": 0}

        class FakeDb:
            def close(self):
                closes["n"] += 1

        monkeypatch.setattr(cli, "_get_db_from_config", lambda a, init_db=True: FakeDb())
        monkeypatch.setattr(
            "oversolved.periodic_tasks.TaskScheduler.force_run_task",
            lambda self, key, db: {"status": "success"},
        )
        args = argparse.Namespace(force_task="document.empty_trash", loop=False)
        cli.run_tasks(args)
        assert closes["n"] == 1


class TestPositiveInt:
    """_positive_int is the argparse type used for --interval."""

    def test_accepts_positive(self):
        assert _positive_int("60") == 60
        assert _positive_int("1") == 1

    def test_rejects_zero(self):
        with pytest.raises(argparse.ArgumentTypeError):
            _positive_int("0")

    def test_rejects_negative(self):
        with pytest.raises(argparse.ArgumentTypeError):
            _positive_int("-5")

    def test_rejects_non_numeric(self):
        with pytest.raises(ValueError):
            _positive_int("abc")

    def test_wired_into_parser_rejects_zero(self):
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["run_tasks", "--interval", "0"])


class TestValidateDbArgs:
    """_validate_db_args builds the DB config dict and guards required args."""

    def test_postgres_with_explicit_dsn(self, monkeypatch):
        monkeypatch.delenv("OVERSOLVED_DB_DSN", raising=False)
        args = build_parser().parse_args(
            ["run_server", "--db-type", "postgres", "--db-dsn", "postgresql://explicit"]
        )
        config = _validate_db_args(args)
        assert config["DB_TYPE"] == "postgres"
        assert config["DB_DSN"] == "postgresql://explicit"
        assert config["DEBUG"] is False
        assert "DB_PATH" not in config

    def test_postgres_falls_back_to_env_dsn(self, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_DB_DSN", "postgresql://from-env")
        args = build_parser().parse_args(["run_server", "--db-type", "postgres"])
        config = _validate_db_args(args)
        assert config["DB_DSN"] == "postgresql://from-env"

    def test_explicit_dsn_takes_precedence_over_env(self, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_DB_DSN", "postgresql://from-env")
        args = build_parser().parse_args(
            ["run_server", "--db-type", "postgres", "--db-dsn", "postgresql://explicit"]
        )
        config = _validate_db_args(args)
        assert config["DB_DSN"] == "postgresql://explicit"

    def test_postgres_without_dsn_exits(self, monkeypatch, capsys):
        monkeypatch.delenv("OVERSOLVED_DB_DSN", raising=False)
        args = build_parser().parse_args(["run_server", "--db-type", "postgres"])
        with pytest.raises(SystemExit) as exc:
            _validate_db_args(args)
        assert exc.value.code == 1
        assert "db-dsn" in capsys.readouterr().out.lower()

    def test_sqlite_uses_db_path(self, monkeypatch):
        monkeypatch.delenv("OVERSOLVED_DB_DSN", raising=False)
        args = build_parser().parse_args(
            ["run_server", "--db-type", "sqlite", "--db-path", "/tmp/over.db"]
        )
        config = _validate_db_args(args)
        assert config["DB_TYPE"] == "sqlite"
        assert config["DB_PATH"] == "/tmp/over.db"
        assert "DB_DSN" not in config

    def test_debug_defaults_false_when_absent(self, monkeypatch):
        # The `db` subcommand has no --debug flag, exercising the getattr default.
        monkeypatch.delenv("OVERSOLVED_DB_DSN", raising=False)
        args = build_parser().parse_args(["db", "--db-type", "sqlite"])
        assert not hasattr(args, "debug")
        config = _validate_db_args(args)
        assert config["DEBUG"] is False

    def test_debug_flag_propagates(self, monkeypatch):
        monkeypatch.delenv("OVERSOLVED_DB_DSN", raising=False)
        args = build_parser().parse_args(
            ["run_server", "--db-type", "postgres", "--db-dsn", "postgresql://x", "--debug"]
        )
        config = _validate_db_args(args)
        assert config["DEBUG"] is True
