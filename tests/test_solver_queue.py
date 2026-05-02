"""Tests for DocumentSolver queue behavior."""
import threading
import time
from oversolved.solver_queue import DocumentSolver


def test_acquire_returns_incrementing_counters():
    solver = DocumentSolver()

    c1 = solver.acquire("doc1")
    assert c1 == 1
    solver.release("doc1", c1, {"result": 1})

    c2 = solver.acquire("doc1")
    assert c2 == 2
    solver.release("doc1", c2, {"result": 2})


def test_acquire_blocks_until_lock_free():
    solver = DocumentSolver()

    c1 = solver.acquire("doc1")

    acquired_second = threading.Event()

    def try_acquire():
        c2 = solver.acquire("doc1")
        acquired_second.set()
        solver.release("doc1", c2, {"result": 2})

    t = threading.Thread(target=try_acquire)
    t.start()

    time.sleep(0.01)
    assert not acquired_second.is_set()

    solver.release("doc1", c1, {"result": 1})

    acquired_second.wait(timeout=0.5)
    assert acquired_second.is_set()
    t.join(timeout=0.5)


def test_different_docs_have_separate_locks():
    solver = DocumentSolver()

    c1 = solver.acquire("doc1")

    acquired_doc2 = threading.Event()

    def acquire_doc2():
        c2 = solver.acquire("doc2")
        acquired_doc2.set()
        solver.release("doc2", c2, {"result": "doc2"})

    t = threading.Thread(target=acquire_doc2)
    t.start()

    acquired_doc2.wait(timeout=0.5)
    assert acquired_doc2.is_set()
    t.join(timeout=0.5)

    solver.release("doc1", c1, {"result": "doc1"})


def test_get_latest_result_returns_most_recent():
    solver = DocumentSolver()

    c1 = solver.acquire("doc1")
    solver.release("doc1", c1, {"result": "first"})

    c2 = solver.acquire("doc1")
    solver.release("doc1", c2, {"result": "second"})

    latest = solver.get_latest_result("doc1")
    assert latest == {"result": "second"}


def test_get_latest_result_returns_none_for_unknown_doc():
    solver = DocumentSolver()
    assert solver.get_latest_result("unknown") is None


def test_get_lock_thread_safe():
    """Concurrent get_lock() calls for same new doc_id both return a Lock."""
    solver = DocumentSolver()
    results: list = []
    errors: list = []

    def get_lock_for_new_doc():
        try:
            lock = solver.get_lock("new_doc")
            results.append(lock)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=get_lock_for_new_doc) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(results) == 10
    assert all(r is not None for r in results)
    # All should get the same lock object (not created twice)
    first = results[0]
    assert all(r is first for r in results)


def test_concurrent_acquire_release():
    """Tight-loop concurrent acquire/release on same doc does not deadlock."""
    solver = DocumentSolver()
    errors: list = []

    def worker():
        for _ in range(50):
            try:
                c = solver.acquire("shared_doc")
                solver.release("shared_doc", c, {"result": c})
            except Exception as e:
                errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    # After all work, the counter should have reached 500 (50 * 10)
    latest = solver.get_latest_result("shared_doc")
    assert latest is not None
    assert latest["result"] == 500, f"Expected counter 500, got {latest['result']}"
