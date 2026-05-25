"""Unit tests for the typed query classes introduced in query.py.

Tests are pure Python -- no OCC, no solver, no Repository.
"""
import pytest
from oversolved.kernel.query import (
    LocalQuery, AbsoluteQuery, AncestryQuery,
    parse_query, emit_wire,
    local, absolute, ancestry,
    make_ancestry_query,
    _TYPE_HIERARCHY, _KNOWN_GEOMETRY_TYPES, _validate_type_hierarchy, _is_subtype,
)


# LocalQuery

def test_local_query_no_sub():
    assert emit_wire(LocalQuery("line1")) == "$line1"


def test_local_query_with_sub():
    assert emit_wire(LocalQuery("line1", "start")) == "$line1start"


def test_local_from_string_no_sub():
    q = parse_query("$line1")
    assert q == LocalQuery(eid="line1", sub="")


def test_local_from_string_start():
    q = parse_query("$line1start")
    assert q == LocalQuery(eid="line1", sub="start")


def test_local_from_string_end():
    q = parse_query("$line1end")
    assert q == LocalQuery(eid="line1", sub="end")


def test_local_from_string_center():
    q = parse_query("$line1center")
    assert q == LocalQuery(eid="line1", sub="center")


def test_local_from_string_xy():
    q = parse_query("$line1xy")
    assert q == LocalQuery(eid="line1", sub="xy")


def test_local_roundtrip():
    for sub in ("", "start", "end", "center", "xy"):
        q = LocalQuery(eid="e1", sub=sub)
        assert parse_query(emit_wire(q)) == q


def test_local_equality():
    assert LocalQuery("e1", "start") == LocalQuery("e1", "start")
    assert LocalQuery("e1", "start") != LocalQuery("e1", "end")


# AbsoluteQuery

def test_absolute_feature_plane():
    assert emit_wire(AbsoluteQuery("sketch1")) == "@sketch1"


def test_absolute_element():
    assert emit_wire(AbsoluteQuery("sketch1", "line1")) == "@sketch1/line1"


def test_absolute_element_with_sub():
    assert emit_wire(AbsoluteQuery("sketch1", "line1", "start")) == "@sketch1/line1/start"


def test_absolute_from_string():
    q = parse_query("@sketch1/line1")
    assert isinstance(q, AbsoluteQuery)
    assert q.feature_id == "sketch1"
    assert q.eid == "line1"
    assert q.sub == ""


def test_absolute_from_string_sub():
    q = parse_query("@sketch1/line1/start")
    assert q == AbsoluteQuery(feature_id="sketch1", eid="line1", sub="start")


def test_absolute_roundtrip():
    for s in ("@sketch1", "@sketch1/line1", "@sketch1/line1/start"):
        assert emit_wire(parse_query(s)) == s


def test_absolute_feature_plane_factory():
    assert emit_wire(AbsoluteQuery.feature_plane("sk1")) == "@sk1"


def test_absolute_element_factory():
    assert emit_wire(AbsoluteQuery.element("sk1", "l1", "end")) == "@sk1/l1/end"


# AncestryQuery

def test_ancestry_two_ids():
    ids = ["@sk1a", "@sk1b"]
    assert emit_wire(ancestry(ids)) == make_ancestry_query(ids)


def test_ancestry_with_type():
    s = emit_wire(ancestry(["@a", "@b"], "flatface"))
    assert s.endswith(":flatface")


def test_ancestry_from_string_no_type():
    # "@sk1a" has length 5 -> hex "5"
    q = parse_query("?5,5;@sk1a@sk1b")
    assert isinstance(q, AncestryQuery)
    assert list(q.ancestor_ids) == ["@sk1a", "@sk1b"]


def test_ancestry_from_string_typed():
    q = parse_query("?5,5;@sk1a@sk1b:flatface")
    assert isinstance(q, AncestryQuery)
    assert q.type_restriction == "flatface"


def test_ancestry_roundtrip():
    ids = ["@sk1a", "@sk1b"]
    base = make_ancestry_query(ids, "flatface")
    q = parse_query(base)
    assert emit_wire(q) == base


def test_ancestry_nested():
    inner = ancestry(["@a", "@b"], "flatface")
    outer = ancestry([inner, "@c"])
    wire = emit_wire(outer)
    assert emit_wire(inner) in wire


def test_ancestry_accepts_query_objects():
    a = absolute("sk1", "a")
    b = absolute("sk1", "b")
    q = ancestry([a, b])
    assert list(q.ancestor_ids) == ["@sk1/a", "@sk1/b"]


# parse_query dispatch

def test_parse_query_local():
    assert isinstance(parse_query("$x"), LocalQuery)


def test_parse_query_absolute():
    assert isinstance(parse_query("@x"), AbsoluteQuery)


def test_parse_query_ancestry():
    assert isinstance(parse_query("?1;x"), AncestryQuery)


def test_parse_query_invalid_empty():
    with pytest.raises(ValueError):
        parse_query("")


def test_parse_query_invalid_prefix():
    with pytest.raises(ValueError):
        parse_query("xbad")


# Constructor helpers

def test_helper_local():
    assert local("e") == LocalQuery(eid="e", sub="")


def test_helper_local_sub():
    assert local("e", "start") == LocalQuery(eid="e", sub="start")


def test_helper_absolute():
    assert absolute("f", "e") == AbsoluteQuery(feature_id="f", eid="e")


def test_helper_ancestry_strings():
    q = ancestry(["@a", "@b"])
    assert q.ancestor_ids == ("@a", "@b")


def test_helper_ancestry_objects():
    q1 = ancestry([absolute("f", "a"), absolute("f", "b")])
    q2 = ancestry(["@f/a", "@f/b"])
    assert q1 == q2


# emit_wire is the only exit point

def test_emit_wire_local():
    assert emit_wire(LocalQuery("e1", "start")) == "$e1start"


def test_emit_wire_absolute():
    assert emit_wire(AbsoluteQuery("sk1", "l1", "end")) == "@sk1/l1/end"


def test_emit_wire_ancestry():
    s = emit_wire(AncestryQuery(("@a", "@b"), "flatface"))
    assert s.endswith(":flatface")


def test_emit_wire_roundtrip():
    for q in [LocalQuery("e1"), LocalQuery("e1", "start")]:
        assert parse_query(emit_wire(q)) == q

    for q in [AbsoluteQuery("sk1"), AbsoluteQuery("sk1", "l1"), AbsoluteQuery("sk1", "l1", "end")]:
        assert parse_query(emit_wire(q)) == q


# Backward compatibility shim

def test_make_ancestry_query_shim():
    ids = ["@sk1a", "@sk1b"]
    assert make_ancestry_query(ids, "flatface") == emit_wire(ancestry(ids, "flatface"))


# ─── Type hierarchy validation (fix-119) ───

def test_type_hierarchy_is_complete():
    assert _KNOWN_GEOMETRY_TYPES <= set(_TYPE_HIERARCHY.keys())


def test_type_hierarchy_parents_are_valid():
    registered = set(_TYPE_HIERARCHY.keys())
    for type_name, meta in _TYPE_HIERARCHY.items():
        for parent in meta.get('parents', []):
            assert parent in registered, f"type '{type_name}' has unknown parent '{parent}'"


def test_is_subtype_known_relationships():
    assert _is_subtype('flatface', 'face') is True
    assert _is_subtype('cylinderface', 'face') is True
    assert _is_subtype('straightedge', 'edge') is True
    assert _is_subtype('face', 'flatface') is False
    assert _is_subtype('flatface', 'edge') is False
    assert _is_subtype(None, 'face') is False


def test_validate_raises_on_missing_type():
    import unittest.mock as mock
    truncated = {k: v for k, v in _TYPE_HIERARCHY.items() if k != 'vertex'}
    with mock.patch('oversolved.kernel.query._TYPE_HIERARCHY', truncated):
        with pytest.raises(AssertionError, match="missing types"):
            _validate_type_hierarchy()


def test_validate_raises_on_bad_parent():
    import unittest.mock as mock
    bad = {**_TYPE_HIERARCHY, 'newtype': {'parents': ['nonexistent']}}
    with mock.patch('oversolved.kernel.query._TYPE_HIERARCHY', bad):
        with pytest.raises(AssertionError, match="unknown parent"):
            _validate_type_hierarchy()
