"""Tests for solver_daemon.py — worker pool and error responses."""

import asyncio
import time
from unittest.mock import MagicMock, patch

from oversolved.solver_daemon import WorkerPool
from oversolved.kernel.errors import error_result


class TestErrorResult:
    def test_returns_expected_dict(self):
        result = error_result("something went wrong")
        assert result == {
            "ok": False,
            "error": "something went wrong",
            "code": "SOLVER_ERROR",
        }

    def test_includes_custom_code(self):
        result = error_result("connection timeout", "TIMEOUT")
        assert result["ok"] is False
        assert result["error"] == "connection timeout"
        assert result["code"] == "TIMEOUT"


class TestWorkerPool:
    def _run(self, coro):
        return asyncio.run(coro)

    def test_acquire_creates_worker(self):
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_worker = MagicMock()
                mock_cls.return_value = mock_worker
                pool = WorkerPool(timeout=5.0, max_workers=4)
                worker = await pool.acquire("conn-1")
                assert worker is mock_worker
                assert "conn-1" in pool._workers
                mock_cls.assert_called_once_with(5.0)
        self._run(_test())

    def test_acquire_reuses_existing_worker(self):
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_worker = MagicMock()
                mock_cls.return_value = mock_worker
                pool = WorkerPool(timeout=5.0, max_workers=4)
                w1 = await pool.acquire("conn-1")
                w2 = await pool.acquire("conn-1")
                assert w1 is w2
                assert mock_cls.call_count == 1
        self._run(_test())

    def test_release_shuts_down_worker(self):
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_worker = MagicMock()
                mock_cls.return_value = mock_worker
                pool = WorkerPool(timeout=5.0, max_workers=4)
                await pool.acquire("conn-1")
                await pool.release("conn-1")
                mock_worker.shutdown.assert_called_once()
                assert "conn-1" not in pool._workers
        self._run(_test())

    def test_release_nonexistent_connection_is_noop(self):
        async def _test():
            pool = WorkerPool(timeout=5.0, max_workers=4)
            await pool.release("no-such-connection")  # must not raise
        self._run(_test())

    def test_pool_caps_at_max_workers(self):
        """Pool size never exceeds max_workers even with many connections."""
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                workers = [MagicMock() for _ in range(20)]
                mock_cls.side_effect = workers
                pool = WorkerPool(timeout=5.0, max_workers=4)
                # Acquire 8 connections serially; LRU idle eviction keeps pool at 4.
                for i in range(8):
                    await pool.acquire(f"conn-{i}")
                    assert len(pool._workers) <= 4
        self._run(_test())

    def test_pool_evicts_lru_idle_worker(self):
        """Third connection with max_workers=2 evicts the LRU idle worker."""
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                w1, w2, w3 = MagicMock(), MagicMock(), MagicMock()
                mock_cls.side_effect = [w1, w2, w3]
                pool = WorkerPool(timeout=5.0, max_workers=2)

                await pool.acquire("conn-1")
                await pool.acquire("conn-2")
                # Neither in flight — conn-1 is LRU (acquired first).
                await pool.acquire("conn-3")

                assert "conn-1" not in pool._workers
                assert "conn-3" in pool._workers
                assert len(pool._workers) <= 2
                w1.shutdown.assert_called_once()
        self._run(_test())

    def test_pool_queues_when_all_busy(self):
        """Acquire waits when all workers are in-flight, then succeeds."""
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_cls.side_effect = [MagicMock() for _ in range(10)]
                pool = WorkerPool(timeout=5.0, max_workers=2, queue_timeout=2.0)

                await pool.acquire("conn-1")
                await pool.acquire("conn-2")
                # Mark both in-flight.
                pool.mark_in_flight("conn-1")
                pool.mark_in_flight("conn-2")

                # Start a waiter task.
                acquired = asyncio.Event()

                async def _waiter():
                    await pool.acquire("conn-3")
                    acquired.set()

                task = asyncio.create_task(_waiter())
                await asyncio.sleep(0.05)  # let waiter block

                assert not acquired.is_set()  # still waiting

                # Free up conn-1 so LRU eviction works.
                await pool.mark_done("conn-1")
                await asyncio.sleep(0.05)
                assert acquired.is_set()
                task.cancel()
        self._run(_test())

    def test_acquire_times_out_when_all_busy(self):
        """Acquire raises TimeoutError after queue_timeout if all workers busy."""
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_cls.side_effect = [MagicMock() for _ in range(5)]
                pool = WorkerPool(timeout=5.0, max_workers=1, queue_timeout=0.1)
                await pool.acquire("conn-1")
                pool.mark_in_flight("conn-1")

                try:
                    await pool.acquire("conn-2")
                    assert False, "should have raised TimeoutError"
                except asyncio.TimeoutError:
                    pass
        self._run(_test())

    def test_idle_reaper_evicts_idle_workers(self):
        """idle_reaper removes workers idle longer than idle_timeout."""
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                w = MagicMock()
                mock_cls.return_value = w
                pool = WorkerPool(timeout=5.0, max_workers=4, idle_timeout=0.05)
                await pool.acquire("conn-1")
                # Manually backdate last_used to simulate idle.
                pool._last_used["conn-1"] = time.monotonic() - 1.0

                reaper = asyncio.create_task(pool.idle_reaper())
                await asyncio.sleep(0.15)
                reaper.cancel()

                assert "conn-1" not in pool._workers
                w.shutdown.assert_called_once()
        self._run(_test())

    def test_mark_in_flight_and_done(self):
        async def _test():
            with patch("oversolved.solver_daemon._Worker") as mock_cls:
                mock_cls.return_value = MagicMock()
                pool = WorkerPool(timeout=5.0, max_workers=4)
                await pool.acquire("conn-1")
                pool.mark_in_flight("conn-1")
                assert pool._in_flight["conn-1"] == 1
                await pool.mark_done("conn-1")
                assert pool._in_flight["conn-1"] == 0
        self._run(_test())


class TestBuildStateCache:
    """Tests for prev_states TtlCache behavior inside _build_worker."""

    def test_ttl_cache_evicts_lru(self):
        from oversolved.cache import TtlCache
        cache: TtlCache = TtlCache(ttl_seconds=3600, max_size=32)
        for i in range(50):
            cache.set(f"doc-{i}", f"state-{i}")
        entries = cache.get_entries()
        assert len(entries) == 32
        # Newest 32 entries should be present.
        for i in range(18, 50):
            assert f"doc-{i}" in entries
        # Oldest 18 should be gone.
        for i in range(18):
            assert f"doc-{i}" not in entries

    def test_ttl_cache_expiry(self):
        from oversolved.cache import TtlCache
        cache: TtlCache = TtlCache(ttl_seconds=0.01, max_size=100)
        cache.set("doc-1", "state-1")
        time.sleep(0.05)
        assert cache.get("doc-1") is None  # expired
