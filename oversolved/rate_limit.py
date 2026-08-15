"""Sliding-window IP-keyed rate limiter."""

import threading
from time import time


class RateLimiter:
    """Thread-safe sliding-window rate limiter.

    Tracks event timestamps per key and blocks when the count within
    the window exceeds max_events.
    """

    def __init__(self, window_s: int, max_events: int):
        self._window_s = window_s
        self._max_events = max_events
        self._events: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = time()

    def _sweep(self, now: float) -> None:
        """Drop keys whose events have all aged out. The caller must hold the lock.

        Only is_exceeded() expires a key, so a key that is recorded but never
        checked (any IP that never reaches the limit) would otherwise live for
        the process lifetime and grow the dict without bound.
        """
        stale = [
            key for key, events in self._events.items()
            if not events or now - events[-1] >= self._window_s
        ]
        for key in stale:
            del self._events[key]
        self._last_sweep = now

    def is_exceeded(self, key: str) -> bool:
        """Return True if the key has already hit the limit."""
        now = time()
        with self._lock:
            events = self._events.get(key, [])
            events[:] = [t for t in events if now - t < self._window_s]
            if not events:
                self._events.pop(key, None)
                return False
            return len(events) >= self._max_events

    def record(self, key: str) -> None:
        """Record one event for the given key."""
        now = time()
        with self._lock:
            # One sweep per window keeps the eviction cost amortized to O(1) per record.
            if now - self._last_sweep >= self._window_s:
                self._sweep(now)
            events = self._events.get(key)
            if events is None:
                self._events[key] = [now]
            else:
                events.append(now)

    def clear(self, key: str) -> None:
        """Remove all recorded events for a key."""
        with self._lock:
            self._events.pop(key, None)
