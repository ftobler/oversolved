"""Thread-safe TTL cache for in-memory build states and persistent L2 cache."""

import json
import os
import threading
import time
from typing import Generic, TypeVar

from oversolved.serialization import deserialize_build_state, serialize_build_state
from oversolved.types3d import BuildState

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


class L2Cache:
    """Persistent L2 cache that stores BuildState on disk as JSON + STEP."""

    def __init__(
        self,
        ttl_seconds: float = 86400 * 30,
        max_size: int = 5000,
        cache_dir: str = "/tmp/oversolved_l2_cache",
    ) -> None:
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._cache_dir = cache_dir
        self._lock = threading.Lock()
        os.makedirs(cache_dir, exist_ok=True)

    def _path(self, key: str) -> str:
        safe_key = key.replace("/", "_").replace("\\", "_")
        return os.path.join(self._cache_dir, f"{safe_key}.json")

    def get(self, key: str) -> BuildState | None:
        path = self._path(key)
        with self._lock:
            if not os.path.exists(path):
                return None
            mtime = os.path.getmtime(path)
            if time.time() - mtime > self._ttl:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                return None
            # Refresh access time for LRU
            os.utime(path, None)

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return deserialize_build_state(data)
        except Exception:
            return None

    def set(self, key: str, state: BuildState) -> None:
        data = serialize_build_state(state)
        path = self._path(key)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        with self._lock:
            os.replace(tmp_path, path)
            self._evict_expired_and_oversized()

    def clear(self) -> None:
        with self._lock:
            for fname in os.listdir(self._cache_dir):
                if fname.endswith(".json"):
                    try:
                        os.unlink(os.path.join(self._cache_dir, fname))
                    except OSError:
                        pass

    def _evict_expired_and_oversized(self) -> None:
        now = time.time()
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
            if now - mtime > self._ttl:
                try:
                    os.unlink(fpath)
                except OSError:
                    pass
            else:
                total_size += size
                survivors.append((fpath, mtime, size))

        # LRU eviction by size (oldest first)
        if total_size > self._max_size:
            survivors.sort(key=lambda x: x[1])
            for fpath, _mtime, size in survivors:
                if total_size <= self._max_size:
                    break
                try:
                    os.unlink(fpath)
                    total_size -= size
                except OSError:
                    pass
