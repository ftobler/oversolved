"""Tests for solver_daemon.py — worker pool and error responses."""

from unittest.mock import MagicMock, patch

from oversolved.solver_daemon import WorkerPool, _error_result


class TestErrorResult:
    def test_returns_expected_dict(self):
        result = _error_result("something went wrong")
        assert result == {
            "solve_ms": 0,
            "result": {"_error": "something went wrong"},
            "bodies": {},
        }

    def test_includes_custom_message(self):
        result = _error_result("connection timeout")
        assert result["result"]["_error"] == "connection timeout"


class TestWorkerPool:
    def test_acquire_creates_worker(self):
        with patch("oversolved.solver_daemon._Worker") as mock_cls:
            mock_worker = MagicMock()
            mock_cls.return_value = mock_worker

            pool = WorkerPool(timeout=5.0)
            worker = pool.acquire("conn-1")

            assert worker is mock_worker
            assert "conn-1" in pool._workers
            mock_cls.assert_called_once_with(5.0)

    def test_acquire_reuses_existing_worker(self):
        with patch("oversolved.solver_daemon._Worker") as mock_cls:
            mock_worker = MagicMock()
            mock_cls.return_value = mock_worker

            pool = WorkerPool(timeout=5.0)
            w1 = pool.acquire("conn-1")
            w2 = pool.acquire("conn-1")

            assert w1 is w2
            assert mock_cls.call_count == 1

    def test_release_shuts_down_worker(self):
        with patch("oversolved.solver_daemon._Worker") as mock_cls:
            mock_worker = MagicMock()
            mock_cls.return_value = mock_worker

            pool = WorkerPool(timeout=5.0)
            pool.acquire("conn-1")
            pool.release("conn-1")

            mock_worker.shutdown.assert_called_once()
            assert "conn-1" not in pool._workers

    def test_release_nonexistent_connection_is_noop(self):
        pool = WorkerPool(timeout=5.0)
        pool.release("no-such-connection")
