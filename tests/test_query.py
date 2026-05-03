import pytest
from oversolved.query import (
    Query, Repository, AmbiguousQueryError,
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

def test_partial_resolve_extra_ancestor_in_query():
    """Query carries ancestor C that the element no longer needs - still resolves."""
    repo = Repository()
    pt = {"type": "pt"}
    # Element registered with only A and B (geometry simplified)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    # Old query was stored with A, B, C (e.g. originally three lines met here)
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3])
    assert repo.query(q) is pt


def test_partial_resolve_with_type_restriction():
    """Partial resolve still honours type restriction."""
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3],
        type_restriction="pt",
    )
    assert repo.query(q) is pt


def test_partial_resolve_type_mismatch_returns_none():
    repo = Repository()
    pt = {"type": "pt"}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt)

    q = make_ancestry_query(
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3],
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
    """Two elements share ancestor A; query with {A, B, C} finds both via
    partial match → ambiguous."""
    repo = Repository()
    pt1 = {"type": "pt"}
    pt2 = {"type": "pt"}
    # pt1 needs only {A, B}, pt2 needs only {A, C}
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE2], pt1)
    repo.register_ancestor(["@" + FEAT + ELE1, "@" + FEAT + ELE3], pt2)

    # Query carries {A, B, C} - both subsets match
    q = make_ancestry_query(["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3])
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
        ["@" + FEAT + ELE1, "@" + FEAT + ELE2, "@" + FEAT + ELE3],
        type_restriction="pt",
    )
    assert repo.query(q) is pt1


# ── Query class  ──

def test_query_class_absolute():
    repo = Repository()
    obj = {"v": 99}
    repo.register(FEAT + ELE1, obj)
    q = Query("@" + FEAT + ELE1)
    assert q.resolve(repo) is obj


def test_query_class_local():
    repo = Repository()
    obj = {"v": 7}
    repo.register(FEAT + ELE1, obj)
    q = Query("$" + ELE1)
    assert q.resolve(repo, context=FEAT) is obj


def test_query_class_str():
    q = Query("@" + FEAT + ELE1)
    assert str(q) == "@" + FEAT + ELE1


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
