import concurrent.futures

from oversolved.kernel.solver import _get_or_build_repo, _repo_structure_cache_lock


def _make_entities(prefix: str) -> dict:
    return {
        f"{prefix}_l1": {"kind": "line"},
        f"{prefix}_p1": {"kind": "point"},
    }


def test_get_or_build_repo_cache_hit_returns_same_object():
    """Two calls with identical args return the same Repository object."""
    entities = _make_entities("sk0")
    repo_a = _get_or_build_repo("sk0", entities)
    repo_b = _get_or_build_repo("sk0", entities)
    assert repo_a is repo_b


def test_get_or_build_repo_cache_miss_returns_distinct_objects():
    """Different feature IDs produce distinct Repository objects."""
    repo_a = _get_or_build_repo("skA", _make_entities("a"))
    repo_b = _get_or_build_repo("skB", _make_entities("b"))
    assert repo_a is not repo_b


def test_get_or_build_repo_lock_is_held_correctly():
    """The module-level lock is accessible and not permanently held after a call."""
    _get_or_build_repo("sk_lock_test", _make_entities("lt"))
    acquired = _repo_structure_cache_lock.acquire(blocking=False)
    assert acquired, "lock was not released after _get_or_build_repo"
    _repo_structure_cache_lock.release()


def test_get_or_build_repo_concurrent_same_key():
    """Concurrent calls with the same key do not raise and all return a Repository."""
    from oversolved.kernel.query import Repository

    entities = _make_entities("conc")
    results = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_get_or_build_repo, "conc_sk", entities) for _ in range(8)]
        for f in concurrent.futures.as_completed(futures):
            results.append(f.result())

    assert all(isinstance(r, Repository) for r in results)


def test_get_or_build_repo_concurrent_different_keys():
    """Concurrent calls with different keys do not raise and each returns a Repository."""
    from oversolved.kernel.query import Repository

    results = {}

    def _call(i: int):
        return _get_or_build_repo(f"diff_sk_{i}", _make_entities(f"d{i}"))

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_call, i): i for i in range(8)}
        for f, i in futures.items():
            results[i] = f.result()

    assert all(isinstance(r, Repository) for r in results.values())
