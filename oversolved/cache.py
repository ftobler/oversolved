"""Thread-safe TTL cache for in-memory build states."""

import threading
import time
from typing import Generic, TypeVar

T = TypeVar("T")


class _BaseCache(Generic[T]):
    """Shared TTL + lock management for thread-safe caches.

    Provides delete()/clear() with lock acquisition and _is_expired() for
    common TTL comparison. Subclasses override storage hooks.
    """

    def __init__(self, ttl_seconds: float, max_size: int) -> None:
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._lock = threading.Lock()

    def delete(self, key: str) -> None:
        with self._lock:
            self._store_delete(key)

    def clear(self) -> None:
        with self._lock:
            self._store_clear()

    def _is_expired(self, ts: float) -> bool:
        return time.time() - ts > self._ttl

    def _store_delete(self, key: str) -> None:
        raise NotImplementedError

    def _store_clear(self) -> None:
        raise NotImplementedError


class TtlCache(_BaseCache[T]):
    """Simple dict-like cache with TTL eviction and optional max size.

    Accessing an entry resets its TTL timer.  Eviction happens lazily on
    get/set and is guarded by an internal lock so the cache is safe for
    multi-threaded use.
    """

    def __init__(self, ttl_seconds: float = 300.0, max_size: int = 1000) -> None:
        super().__init__(ttl_seconds, max_size)
        self._data: dict[str, tuple[T, float]] = {}

    def get(self, key: str) -> T | None:
        with self._lock:
            self._evict_expired()
            entry = self._data.get(key)
            if entry is None:
                return None
            value, _ = entry
            # Reset TTL on access and move to end for LRU ordering
            del self._data[key]
            self._data[key] = (value, time.time())
            return value

    def set(self, key: str, value: T) -> None:
        with self._lock:
            self._evict_expired()
            if key in self._data:
                del self._data[key]
            self._data[key] = (value, time.time())
            while len(self._data) > self._max_size:
                oldest = next(iter(self._data))
                del self._data[oldest]

    def get_entries(self) -> dict[str, tuple[T, float]]:
        """Return a copy of all cache entries for inspection."""
        with self._lock:
            return dict(self._data)

    def _evict_expired(self) -> None:
        expired = [k for k, (_, ts) in self._data.items() if self._is_expired(ts)]
        for k in expired:
            del self._data[k]

    def _store_delete(self, key: str) -> None:
        self._data.pop(key, None)

    def _store_clear(self) -> None:
        self._data.clear()
