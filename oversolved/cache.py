"""Thread-safe TTL cache for in-memory build states and persistent L2 cache."""

import json
import os
import threading
import time
from typing import Generic, TypeVar

from oversolved.serialization import deserialize_build_state, serialize_build_state
from oversolved.types3d import BuildState

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


class L2Cache(_BaseCache[BuildState]):
    """Persistent L2 cache that stores BuildState on disk as JSON + STEP."""

    def __init__(
        self,
        ttl_seconds: float = 86400 * 30,
        max_size: int = 5000,
        cache_dir: str = "/tmp/oversolved_l2_cache",
    ) -> None:
        super().__init__(ttl_seconds, max_size)
        self._cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)

    def get_cache_dir(self) -> str:
        """Return the cache directory path (public accessor for admin inspection)."""
        return self._cache_dir

    def _path(self, key: str) -> str:
        safe_key = key.replace("/", "_").replace("\\", "_")
        return os.path.join(self._cache_dir, f"{safe_key}.json")

    def get(self, key: str) -> BuildState | None:
        path = self._path(key)
        try:
            with self._lock:
                if not os.path.exists(path):
                    return None
                mtime = os.path.getmtime(path)
                if self._is_expired(mtime):
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                    return None
                # Refresh access time for LRU; ignore errors (e.g. permission denied)
                try:
                    os.utime(path, None)
                except OSError:
                    pass

                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            return deserialize_build_state(data)
        except Exception:
            return None

    def set(self, key: str, state: BuildState) -> None:
        data = serialize_build_state(state)
        path = self._path(key)
        tmp_path = path + ".tmp"
        with self._lock:
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                os.replace(tmp_path, path)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            self._evict_expired_and_oversized()

    def _store_delete(self, key: str) -> None:
        path = self._path(key)
        try:
            os.unlink(path)
        except OSError:
            pass

    def _store_clear(self) -> None:
        for fname in os.listdir(self._cache_dir):
            if fname.endswith(".json"):
                try:
                    os.unlink(os.path.join(self._cache_dir, fname))
                except OSError:
                    pass

    def _evict_expired_and_oversized(self) -> None:
        entries = []
        for fname in os.listdir(self._cache_dir):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(self._cache_dir, fname)
            try:
                stat = os.stat(fpath)
                entries.append((fpath, stat.st_mtime, stat.st_size))
            except OSError:
                continue

        # Remove expired first
        total_size = 0
        survivors = []
        for fpath, mtime, size in entries:
            if self._is_expired(mtime):
                try:
                    os.unlink(fpath)
                except OSError:
                    pass
            else:
                total_size += size
                survivors.append((fpath, mtime, size))

        # LRU eviction by size (oldest first)
        if total_size > self._max_size:
            survivors.sort(key=lambda x: (x[1], x[0]))
            for fpath, _mtime, size in survivors:
                if total_size <= self._max_size:
                    break
                try:
                    os.unlink(fpath)
                    total_size -= size
                except OSError:
                    pass
