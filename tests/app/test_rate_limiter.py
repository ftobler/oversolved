"""Unit tests for RateLimiter."""

import threading

from oversolved.rate_limit import RateLimiter


class TestRateLimiter:

    def test_rate_limiter_allows_under_threshold(self):
        limiter = RateLimiter(window_s=60, max_events=5)
        for _ in range(4):
            limiter.record("ip1")
        assert not limiter.is_exceeded("ip1")

    def test_rate_limiter_blocks_at_threshold(self):
        limiter = RateLimiter(window_s=60, max_events=5)
        for _ in range(5):
            limiter.record("ip1")
        assert limiter.is_exceeded("ip1")

    def test_rate_limiter_window_slides(self, monkeypatch):
        """Events outside the window no longer count."""
        fake_time = [1000.0]
        monkeypatch.setattr("oversolved.rate_limit.time", lambda: fake_time[0])

        limiter = RateLimiter(window_s=60, max_events=3)
        for _ in range(3):
            limiter.record("ip1")
        assert limiter.is_exceeded("ip1")

        fake_time[0] += 61  # slide past the window
        assert not limiter.is_exceeded("ip1")

    def test_rate_limiter_clear_resets_key(self):
        limiter = RateLimiter(window_s=60, max_events=3)
        for _ in range(3):
            limiter.record("ip1")
        assert limiter.is_exceeded("ip1")
        limiter.clear("ip1")
        assert not limiter.is_exceeded("ip1")

    def test_rate_limiter_concurrency(self):
        """100 threads racing on record must result in exactly 100 events."""
        limiter = RateLimiter(window_s=300, max_events=1000)
        barrier = threading.Barrier(100)

        def _worker():
            barrier.wait()
            limiter.record("shared")

        threads = [threading.Thread(target=_worker) for _ in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        count = len(limiter._events.get("shared", []))
        assert count == 100

    def test_recorded_keys_are_swept_once_stale(self, monkeypatch):
        """A key that is recorded but never checked must not live forever."""
        fake_time = [1000.0]
        monkeypatch.setattr("oversolved.rate_limit.time", lambda: fake_time[0])

        limiter = RateLimiter(window_s=60, max_events=5)
        limiter.record("never_checked")
        assert "never_checked" in limiter._events

        fake_time[0] += 61  # a full window passes without any is_exceeded call
        limiter.record("fresh")
        assert "never_checked" not in limiter._events
        assert "fresh" in limiter._events

    def test_sweep_keeps_keys_inside_the_window(self, monkeypatch):
        """The sweep must not evict keys that still have live events."""
        fake_time = [1000.0]
        monkeypatch.setattr("oversolved.rate_limit.time", lambda: fake_time[0])

        limiter = RateLimiter(window_s=60, max_events=5)
        limiter.record("old")
        fake_time[0] += 59
        limiter.record("recent")
        fake_time[0] += 2  # now past the window for "old" but not for "recent"
        limiter.record("trigger")
        assert "old" not in limiter._events
        assert "recent" in limiter._events

    def test_sweep_does_not_run_on_every_record(self, monkeypatch):
        """Sweeping is amortized: within one window no eviction pass happens."""
        fake_time = [1000.0]
        monkeypatch.setattr("oversolved.rate_limit.time", lambda: fake_time[0])

        limiter = RateLimiter(window_s=60, max_events=5)
        limiter.record("a")
        fake_time[0] += 10
        limiter.record("b")
        assert limiter._last_sweep == 1000.0

    def test_rate_limiter_independent_keys(self):
        """Different keys do not interfere with each other."""
        limiter = RateLimiter(window_s=60, max_events=2)
        limiter.record("a")
        limiter.record("a")
        assert limiter.is_exceeded("a")
        assert not limiter.is_exceeded("b")
