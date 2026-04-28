"""Thread-safe TTL cache for in-memory build states."""

import threading
import time
from typing import Generic, TypeVar

T = TypeVar("T")


class TtlCache(Generic[T]):
    """Simple dict-like cache with TTL eviction and optional max size.

    Accessing an entry resets its TTL timer.  Eviction happens lazily on
    get/set and is guarded by an internal lock so the cache is safe for
    multi-threaded use.
    """

    def __init__(self, ttl_seconds: float = 300.0, max_size: int = 1000) -> None:
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._data: dict[str, tuple[T, float]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> T | None:
        with self._lock:
            self._evict_expired()
            entry = self._data.get(key)
            if entry is None:
                return None
            value, _ = entry
            # Reset TTL on access (LRU + TTL)
            self._data[key] = (value, time.time())
            return value

    def set(self, key: str, value: T) -> None:
        with self._lock:
            self._evict_expired()
            self._data[key] = (value, time.time())
            if len(self._data) > self._max_size:
                # Remove oldest by insertion/access time
                oldest = next(iter(self._data))
                del self._data[oldest]

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, (_, ts) in self._data.items() if now - ts > self._ttl]
        for k in expired:
            del self._data[k]
