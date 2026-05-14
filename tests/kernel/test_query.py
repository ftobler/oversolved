import pytest
from oversolved.kernel.query import (
    Repository, AmbiguousQueryError,
    make_ancestry_query, _parse_ancestry,
)


FEAT = "A" * 18
ELE1 = "B" * 12
ELE2 = "C" * 12
ELE3 = "D" * 12
ELE4 = "E" * 12


# ── parse_ancestry  ──

def test_parse_ancestry_two_ids():
    ids, typ = _parse_ancestry("?c,c;" + ELE1 + ELE2)
    assert ids == [ELE1, ELE2]
    assert typ is None


def test_parse_ancestry_type_restriction():
    ids, typ = _parse_ancestry("?c,c;" + ELE1 + ELE2 + ":pt")
    assert ids == [ELE1, ELE2]
    assert typ == "pt"


def test_parse_ancestry_single_id():
    ids, typ = _parse_ancestry("?c;" + ELE1)
    assert ids == [ELE1]
    assert typ is None


def test_parse_ancestry_three_ids():
    ids, typ = _parse_ancestry("?c,c,c;" + ELE1 + ELE2 + ELE3)
    assert ids == [ELE1, ELE2, ELE3]
    assert typ is None


# ── make_ancestry_query  ──

def test_make_ancestry_query_roundtrip():
    q = make_ancestry_query([ELE1, ELE2])
    ids, typ = _parse_ancestry(q)
    assert ids == [ELE1, ELE2]
    assert typ is None


# ── 2a: make_ancestry_query face round-trips  ──

def test_make_ancestry_query_face_format():
    """Result starts with '?' and ends with ':face'."""
    ids = ['@sketchAlineX', '@sketchAlineY']
    q = make_ancestry_query(ids, 'face')
    assert q.startswith('?')
    assert q.endswith(':face')


def test_make_ancestry_query_face_roundtrip():
    """_parse_ancestry round-trips any ids and type."""
    ids = ['@sk1a', '@sk1b', '@sk1c']
    q = make_ancestry_query(ids, 'face')
    out_ids, out_type = _parse_ancestry(q)
    assert out_ids == ids
    assert out_type == 'face'


def test_make_ancestry_query_caller_controls_sort_order():
    """Caller is responsible for sort order - different order → different string."""
    q_ab = make_ancestry_query(['@a', '@b'], 'face')
    q_ba = make_ancestry_query(['@b', '@a'], 'face')
    # Different insertion order produces different strings (no implicit sort)
    assert q_ab != q_ba
    # Pre-sorting by caller gives deterministic result
    ids = ['@b', '@a']
    q_sorted = make_ancestry_query(sorted(ids), 'face')
    q_sorted2 = make_ancestry_query(sorted(ids), 'face')
    assert q_sorted == q_sorted2


def test_make_ancestry_query_with_type_roundtrip():
    q = make_ancestry_query([ELE1, ELE2], type_restriction="line")
    ids, typ = _parse_ancestry(q)
    assert ids == [ELE1, ELE2]
    assert typ == "line"


def test_make_ancestry_query_nested():
    inner = make_ancestry_query([ELE1, ELE2])
    outer = make_ancestry_query([inner, ELE1])
    ids, typ = _parse_ancestry(outer)
    assert ids[0] == inner
    assert ids[1] == ELE1


# ── Repository: @absolute  ──

def test_absolute_query():
    repo = Repository()
    obj = {"x": 1}
    repo.register(FEAT + ELE1, obj)
    assert repo.query("@" + FEAT + ELE1) is obj


def test_absolute_query_missing():
    repo = Repository()
    assert repo.query("@" + FEAT + ELE1) is None


def test_absolute_query_subelement():
    repo = Repository()
    pt = {"x": 0, "y": 0}
    repo.register(FEAT + ELE1 + "start", pt)
    assert repo.query("@" + FEAT + ELE1 + "start") is pt


# ── Repository: $local  ──

def test_local_query_with_context():
    repo = Repository()
    obj = {"val": 42}
    repo.register(FEAT + ELE1, obj)
    assert repo.query("$" + ELE1, context=FEAT) is obj


def test_local_query_without_context_returns_none():
    repo = Repository()
    repo.register(FEAT + ELE1, {"val": 42})
    assert repo.query("$" + ELE1) is None


def test_local_query_subelement_with_context():
    repo = Repository()
    pt = {"x": 5, "y": 3}
    repo.register(FEAT + ELE1 + "end", pt)
    assert repo.query("$" + ELE1 + "end", context=FEAT) is pt


# ── Repository: ?ancestry — exact resolve  ──

def test_ancestry_query_exact():
    repo = Repository()
    pt = {"type": "pt", "x": 1.0, "y": 2.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    assert repo.query(q) is pt


def test_ancestry_query_order_independent():
    repo = Repository()
    pt = {"type": "pt", "x": 1.0, "y": 2.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q_reversed = make_ancestry_query(["@" + FEAT + ELE2, "@" + FEAT + ELE1])
    assert repo.query(q_reversed) is pt


def test_ancestry_query_missing():
    repo = Repository()
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    assert repo.query(q) is None


def test_ancestry_query_type_match():
    repo = Repository()
    pt = {"type": "pt", "x": 0.0, "y": 0.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2], type_restriction="pt")
    assert repo.query(q) is pt


def test_ancestry_query_type_mismatch_returns_none():
    repo = Repository()
    pt = {"type": "pt", "x": 0.0, "y": 0.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2], type_restriction="line")
    assert repo.query(q) is None


def test_ancestry_query_no_type_restriction_ignores_obj_type():
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    assert repo.query(q) is pt


# ── Partial resolve  ──
#
# Geometry simplification scenario: a query was built with ancestors {A, B, C}
# (e.g. three concurrent lines), but after a geometry change the element is
# re-registered with only {A, B}. The old query must still resolve because
# {A, B} ⊆ {A, B, C}.

def test_partial_resolve_fewer_query_tags_match():
    """Query with fewer tags matches a registration with more tags (backward compat)."""
    repo = Repository()
    pt = {"type": "pt"}
    # Element registered with A, B, C (e.g. face with index, feature, body, hash)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3], pt)

    # Old query only has A, B (missing the hash tag) - still resolves via subset match
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    assert repo.query(q) is pt


def test_partial_resolve_with_type_restriction():
    """Partial resolve (fewer query tags) still honours type restriction."""
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3], pt)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2],
        type_restriction="pt",
    )
    assert repo.query(q) is pt


def test_partial_resolve_type_mismatch_returns_none():
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3], pt)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2],
        type_restriction="line",
    )
    assert repo.query(q) is None


def test_partial_resolve_not_triggered_when_ancestor_missing():
    """Query has {A, C} but element needs {A, B} - C is not B, no match."""
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    # Query doesn't include ELE2, so {ELE1, ELE2} ⊄ {ELE1, ELE3} → no match
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE3])
    assert repo.query(q) is None


# ── Ambiguous resolve (over-resolve)  ──
#
# If a query matches more than one element, it is ambiguous and must raise.
# This can happen when geometry changes cause multiple elements to be
# reachable through the same ancestor subset.

def test_ambiguous_same_ancestor_set_raises():
    """Two elements registered with identical ancestors (e.g. two circle-circle
    intersection points) - without type restriction the query is ambiguous."""
    repo = Repository()
    pt1 = {"type": "pt", "x": 1.0, "y": 0.0}
    pt2 = {"type": "pt", "x": -1.0, "y": 0.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt2)

    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    with pytest.raises(AmbiguousQueryError):
        repo.query(q)


def test_ambiguous_partial_resolve_raises():
    """Two elements share ancestor A; query with {A, B} finds both via
    partial match (one exact, one subset of larger set) -> ambiguous."""
    repo = Repository()
    pt1 = {"type": "pt"}
    pt2 = {"type": "pt"}
    # pt1 registered with {A, B}, pt2 with {A, B, C}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3], pt2)

    # Query {A, B} matches both: {A,B} <= {A,B} (exact) and {A,B} <= {A,B,C} (subset)
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    with pytest.raises(AmbiguousQueryError):
        repo.query(q)


def test_ambiguous_resolved_by_type():
    """Two circle-circle intersection points are disambiguated by type when
    they carry different types."""
    repo = Repository()
    pt1 = {"type": "pt_upper"}
    pt2 = {"type": "pt_lower"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt2)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2], type_restriction="pt_upper"
    )
    assert repo.query(q) is pt1


def test_ambiguous_partial_resolved_by_type():
    """Partial resolve becomes unambiguous when type narrows it to one."""
    repo = Repository()
    pt1 = {"type": "pt"}
    line1 = {"type": "line"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE3], line1)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2],
        type_restriction="pt",
    )
    assert repo.query(q) is pt1


def test_empty_query_returns_none():
    repo = Repository()
    assert repo.query("") is None


# ── Repository: Global fallback & edge cases  ──

def test_global_fallback():
    """$ query with context falls back to the same global key."""
    repo = Repository()
    obj = {"val": 42}
    repo.register(FEAT + ELE1, obj)
    assert repo.query("$" + ELE1, context=FEAT) is obj


def test_local_and_absolute_both_miss():
    """Neither local nor global has the key."""
    repo = Repository()
    assert repo.query("$" + ELE1, context=FEAT) is None
    assert repo.query("@" + FEAT + ELE1) is None


def test_empty_repo_all_formats():
    """New Repository returns None for all query formats."""
    repo = Repository()
    assert repo.query("$" + ELE1, context=FEAT) is None
    assert repo.query("@" + FEAT + ELE1) is None
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2])
    assert repo.query(q) is None


def test_malformed_ancestry_hex():
    """Non-hex characters in ancestry length raise ValueError."""
    with pytest.raises(ValueError):
        _parse_ancestry("?ZZ;abc")


def test_mismatched_ancestry_length():
    """Extra characters beyond the parsed length are ignored."""
    ids, typ = _parse_ancestry("?3;abcdef")
    assert ids == ["abc"]
    assert typ is None


def test_query_all_superset_match():
    """Two elements sharing an ancestor both appear in query_all."""
    repo = Repository()
    obj1 = {"type": "pt", "x": 1.0}
    obj2 = {"type": "pt", "x": 2.0}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], obj1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE3], obj2)
    q = make_ancestry_query(["@" + FEAT + ELE1])
    matches = repo.query_all(q)
    assert len(matches) == 2
    assert obj1 in matches
    assert obj2 in matches


def test_evict_ancestry_and_register_creates_entry():
    """Register with a simple ancestry; verify ancenstral and elements entries exist."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    aid = _evict_ancestry_and_register(repo, ["@" + FEAT, "@body1"], {"type": "point", "x": 1.0})
    key = frozenset(["@" + FEAT, "@body1"])
    assert key in repo.ancestral
    assert aid in repo.ancestral[key]
    assert repo.elements[aid] == {"type": "point", "x": 1.0}


def test_evict_ancestry_and_register_evicts_stale():
    """Register entry A with index_tag, then B with same tag but different key. A is evicted."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    aid1 = _evict_ancestry_and_register(
        repo, ["@" + ELE1, "@index1"], {"v": 1}, index_tag="@index1",
    )
    key1 = frozenset(["@" + ELE1, "@index1"])
    assert aid1 in repo.elements

    aid2 = _evict_ancestry_and_register(
        repo, ["@" + ELE2, "@index1"], {"v": 2}, index_tag="@index1",
    )
    key2 = frozenset(["@" + ELE2, "@index1"])
    # Old entry should be gone
    assert key1 not in repo.ancestral
    assert aid1 not in repo.elements
    # New entry should be present
    assert key2 in repo.ancestral
    assert aid2 in repo.elements


def test_evict_ancestry_and_register_evicts_exact_key():
    """Re-register with same ancestry but different payload (no index_tag). Old entry gone."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    aid1 = _evict_ancestry_and_register(repo, ["@" + ELE1], {"v": 1})
    assert aid1 in repo.elements
    aid2 = _evict_ancestry_and_register(repo, ["@" + ELE1], {"v": 2})
    assert aid1 not in repo.elements
    assert aid2 in repo.elements
    key = frozenset(["@" + ELE1])
    assert aid2 in repo.ancestral[key]


def test_evict_ancestry_and_register_keeps_unrelated_entries():
    """Register two different tags, re-register one. The other survives."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    aid1 = _evict_ancestry_and_register(
        repo, ["@" + ELE1, "@tag_a"], {"v": 1}, index_tag="@tag_a",
    )
    aid2 = _evict_ancestry_and_register(
        repo, ["@" + ELE2, "@tag_b"], {"v": 2}, index_tag="@tag_b",
    )
    key_a = frozenset(["@" + ELE1, "@tag_a"])
    key_b = frozenset(["@" + ELE2, "@tag_b"])

    _evict_ancestry_and_register(
        repo, ["@" + ELE3, "@tag_a"], {"v": 3}, index_tag="@tag_a",
    )
    # tag_a entries evicted
    assert key_a not in repo.ancestral
    assert aid1 not in repo.elements
    # tag_b entries untouched
    assert key_b in repo.ancestral
    assert aid2 in repo.elements


def test_evict_ancestry_and_register_no_index_tag():
    """Register with index_tag=None. No stale-scan, but exact-key eviction still works."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    aid1 = _evict_ancestry_and_register(repo, ["@" + ELE1], {"v": 1}, index_tag=None)
    # Register a different key; should not evict anything
    _evict_ancestry_and_register(repo, ["@" + ELE2], {"v": 2}, index_tag=None)
    assert aid1 in repo.elements
    # Re-register same key; old entry should be evicted via exact-key path
    aid3 = _evict_ancestry_and_register(repo, ["@" + ELE1], {"v": 3}, index_tag=None)
    assert aid1 not in repo.elements
    assert aid3 in repo.elements


def test_evict_ancestry_and_register_multiple_stale_keys():
    """Register multiple entries sharing same index_tag; re-register one. All stale gone."""
    from oversolved.kernel.query import _evict_ancestry_and_register
    repo = Repository()
    _evict_ancestry_and_register(
        repo, ["@" + ELE1, "@tag"], {"v": 1}, index_tag="@tag",
    )
    _evict_ancestry_and_register(
        repo, ["@" + ELE2, "@tag"], {"v": 2}, index_tag="@tag",
    )
    _evict_ancestry_and_register(
        repo, ["@" + ELE3, "@tag"], {"v": 3}, index_tag="@tag",
    )
    # Each registration evicts previous one with same index_tag, so only last survives
    assert len(repo.ancestral) == 1
    assert len(repo.elements) == 1

    # Re-register with a fresh key; the previous stale entry is evicted
    new_id = _evict_ancestry_and_register(
        repo, ["@" + ELE4, "@tag"], {"v": 4}, index_tag="@tag",
    )
    assert len(repo.ancestral) == 1
    assert len(repo.elements) == 1
    assert new_id in repo.elements
