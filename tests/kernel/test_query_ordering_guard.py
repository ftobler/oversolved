"""Ordering guard: a query from feature N must never resolve against geometry
owned by a feature ordered after N in the current build order.

The gap only appears after a reorder, where an earlier-position feature can be
solved while the repo already holds a later-position feature's geometry. These
tests exercise the Repository contract directly.
"""
import pytest
from oversolved.kernel.query import (
    Repository, AmbiguousQueryError, AncestryQuery, emit_wire,
    _current_feature_id, _feature_idx_of_element,
)


def _reg(repo, ancestors, owner, geom_hash=None, type_="face"):
    """Register an ancestral element owned by `owner` (its created_by)."""
    payload = {"type": type_, "created_by": owner}
    return repo.register_ancestor(ancestors, payload, geom_hash=geom_hash)


def test_no_forward_reference_after_reorder():
    repo = Repository()
    repo.set_feature_order(["sk1", "ex1", "ex2"])
    # Both extrudes are built on sk1, so a broad query for @sk1 matches both.
    _reg(repo, ["@sk1"], owner="ex1")
    _reg(repo, ["@sk1"], owner="ex2")
    q = AncestryQuery.from_parts(["@sk1"])

    # From ex1 the ex2-owned element is forward and must be filtered out,
    # leaving a unique resolution to ex1's own element.
    resolved = repo.query(q, current_feature_id="ex1")
    assert resolved is not None
    assert resolved["created_by"] == "ex1"


def test_builtin_always_resolves():
    repo = Repository()
    repo.set_feature_order(["f0", "f1"])
    # No created_by/sketch_id => built-in, never ordering-gated.
    repo.register_ancestor(["@builtin"], {"type": "plane"})
    q = AncestryQuery.from_parts(["@builtin"])
    resolved = repo.query(q, current_feature_id="f0")
    assert resolved is not None
    assert resolved["type"] == "plane"


def test_feature_idx_of_element_none_for_builtin():
    repo = Repository()
    repo.set_feature_order(["f0"])
    eid = repo.register_ancestor(["@builtin"], {"type": "plane"})
    assert _feature_idx_of_element(repo, eid) is None


def test_absolute_query_still_works():
    repo = Repository()
    repo.set_feature_order(["ex1", "ex2"])
    # Absolute references are explicit and not ordering-gated, even forward.
    repo.register("ex2/vertex/2", {"type": "vertex", "created_by": "ex2"})
    resolved = repo.query("@ex2/vertex/2", current_feature_id="ex1")
    assert resolved is not None
    assert resolved["created_by"] == "ex2"


def test_query_all_respects_ordering():
    repo = Repository()
    repo.set_feature_order(["sk1", "sk2"])
    _reg(repo, ["@sk1"], owner="sk1")
    _reg(repo, ["@sk1"], owner="sk2")
    qs = emit_wire(AncestryQuery.from_parts(["@sk1"]))
    results = repo.query_all(qs, current_feature_id="sk1")
    owners = {r["created_by"] for r in results}
    assert owners == {"sk1"}


def test_ordering_guard_noop_without_current_feature():
    repo = Repository()
    repo.set_feature_order(["ex1", "ex2"])
    _reg(repo, ["@sk1"], owner="ex1")
    _reg(repo, ["@sk1"], owner="ex2")
    q = AncestryQuery.from_parts(["@sk1"])
    # No current feature (and no contextvar) => filter is identity, both match.
    with pytest.raises(AmbiguousQueryError):
        repo.query(q)


def test_tier3_hash_fallback_rejects_forward_match():
    repo = Repository()
    repo.set_feature_order(["f0", "f1"])
    # Identical geom hash, distinct ancestry; query carries only the hash so
    # resolution lands in the tier-3 hash fallback.
    _reg(repo, ["@f0"], owner="f0", geom_hash="gface_X")
    _reg(repo, ["@f1"], owner="f1", geom_hash="gface_X")
    q = AncestryQuery.from_parts(["@gface_X"])
    resolved = repo.query(q, current_feature_id="f0")
    assert resolved is not None
    assert resolved["created_by"] == "f0"


def test_contextvar_drives_guard():
    repo = Repository()
    repo.set_feature_order(["ex1", "ex2"])
    _reg(repo, ["@sk1"], owner="ex1")
    _reg(repo, ["@sk1"], owner="ex2")
    q = AncestryQuery.from_parts(["@sk1"])
    token = _current_feature_id.set("ex1")
    try:
        resolved = repo.query(q)
    finally:
        _current_feature_id.reset(token)
    assert resolved is not None
    assert resolved["created_by"] == "ex1"
