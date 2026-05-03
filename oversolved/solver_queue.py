import threading
from typing import Any, Optional


class DocumentSolver:
    """Serializes solves per document to prevent race conditions.

    For full rebuilds (latest mutation), tasks are queued and only the latest result
    is returned. Stale tasks are cancelled when new ones arrive.
    """

    def __init__(self) -> None:
        self._meta_lock = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._counters: dict[str, int] = {}
        self._results: dict[str, Any] = {}

    def _ensure_lock(self, doc_id: str) -> threading.Lock:
        """Get or create lock for doc_id. Caller must hold _meta_lock."""
        if doc_id not in self._locks:
            self._locks[doc_id] = threading.Lock()
        return self._locks[doc_id]

    def get_lock(self, doc_id: str) -> threading.Lock:
        with self._meta_lock:
            return self._ensure_lock(doc_id)

    def acquire(self, doc_id: str) -> int:
        """Acquire lock for a document. Blocks until lock is free. Returns task counter."""
        lock = self.get_lock(doc_id)
        lock.acquire()
        with self._meta_lock:
            counter = self._counters.get(doc_id, 0) + 1
            self._counters[doc_id] = counter
        return counter

    def release(self, doc_id: str, counter: int, result: Any) -> None:
        """Release lock and store result."""
        with self._meta_lock:
            self._results[doc_id] = result
            # Evict old entries to prevent unbounded memory growth.
            if len(self._results) > 100:
                for key in list(self._results.keys())[:len(self._results) - 100]:
                    del self._results[key]
            lock = self._ensure_lock(doc_id)
        lock.release()

    def get_latest_result(self, doc_id: str) -> Optional[Any]:
        """Get the cached latest result for a document."""
        with self._meta_lock:
            return self._results.get(doc_id)


_document_solver = DocumentSolver()


def get_document_solver() -> DocumentSolver:
    return _document_solver
