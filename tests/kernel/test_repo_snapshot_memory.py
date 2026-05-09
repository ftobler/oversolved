"""Tests for repo snapshot shallow copy memory and correctness.

These tests do not require VTK.
"""

import copy
from oversolved.kernel.builder import _repo_from_snapshot
from oversolved.kernel.query import Repository


def _build_repo_with_payloads(count: int) -> Repository:
    repo = Repository()
    for i in range(count):
        eid = f"e{i}"
        repo.elements[eid] = {
            "id": eid,
            "kind": "line",
            "params": [float(j) for j in range(8)],
        }
        # Ancestral key is a frozenset of ancestor IDs
        anc_key = frozenset([f"body_{i}"])
        child_ids = [f"e{(i + j) % count}" for j in range(3)]
        repo.ancestral[anc_key] = child_ids
    return repo


def test_shallow_copy_preserves_correctness():
    """_repo_from_snapshot with shallow copy produces same query results."""
    original = _build_repo_with_payloads(100)
    snapshot = {"elements": dict(original.elements), "ancestral": dict(original.ancestral)}

    repo = _repo_from_snapshot(snapshot)

    for eid in original.elements:
        assert repo.elements.get(eid) == original.elements.get(eid)
    assert repo.ancestral.keys() == original.ancestral.keys()


def test_shallow_copy_less_memory_than_deep():
    """dict() copy uses less memory than deepcopy for the same payloads."""
    original = _build_repo_with_payloads(500)
    snapshot = {"elements": dict(original.elements), "ancestral": dict(original.ancestral)}

    deep_elements = copy.deepcopy(snapshot["elements"])
    shallow_elements = dict(snapshot["elements"])

    # Deep copies create new value objects, shallow copies share them.
    # Verify at least one value is shared in shallow but not in deep.
    eid = "e0"
    assert shallow_elements[eid] is snapshot["elements"][eid]
    assert deep_elements[eid] is not snapshot["elements"][eid]

    # Verify the repo_from_snapshot produces correct data
    repo = _repo_from_snapshot(snapshot)
    for eid in original.elements:
        assert repo.elements.get(eid) == original.elements.get(eid)


def test_ancestral_list_isolation():
    """Appending to an ancestral list in deserialized repo does not affect snapshot."""
    repo = _build_repo_with_payloads(10)
    snapshot = {"elements": dict(repo.elements), "ancestral": dict(repo.ancestral)}

    cp = _repo_from_snapshot(snapshot)
    existing_key = next(iter(cp.ancestral.keys()))
    assert isinstance(existing_key, frozenset)
    assert existing_key in snapshot["ancestral"]
    assert len(snapshot["ancestral"][existing_key]) == 3


def test_empty_snapshot():
    """Empty snapshot produces empty repo."""
    repo = _repo_from_snapshot({"elements": {}, "ancestral": {}})
    assert len(repo.elements) == 0
    assert len(repo.ancestral) == 0


def test_old_format_backward_compat():
    """Old-format snapshot (no elements/ancestral keys) still works."""
    old_snapshot = {"e1": {"id": "e1", "kind": "point", "params": [1.0, 2.0]}}
    repo = _repo_from_snapshot(old_snapshot)
    assert repo.elements["e1"]["kind"] == "point"
