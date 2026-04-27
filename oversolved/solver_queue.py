import threading
from typing import Any, Optional


class DocumentSolver:
    """Serializes solves per document to prevent race conditions.

    For full rebuilds (latest mutation), tasks are queued and only the latest result
    is returned. Stale tasks are cancelled when new ones arrive.
    """

    def __init__(self):
        self._locks: dict[str, threading.Lock] = {}
        self._counters: dict[str, int] = {}
        self._results: dict[str, Any] = {}

    def get_lock(self, doc_id: str) -> threading.Lock:
        if doc_id not in self._locks:
            self._locks[doc_id] = threading.Lock()
        return self._locks[doc_id]

    def acquire(self, doc_id: str) -> int:
        """Acquire lock for a document. Blocks until lock is free. Returns task counter."""
        lock = self.get_lock(doc_id)
        lock.acquire()
        counter = self._counters.get(doc_id, 0) + 1
        self._counters[doc_id] = counter
        return counter

    def release(self, doc_id: str, counter: int, result: Any) -> None:
        """Release lock and store result."""
        self._results[doc_id] = result
        lock = self.get_lock(doc_id)
        lock.release()

    def get_latest_result(self, doc_id: str) -> Optional[Any]:
        """Get the cached latest result for a document."""
        return self._results.get(doc_id)


_document_solver = DocumentSolver()


def get_document_solver() -> DocumentSolver:
    return _document_solver
