"""Tests for two-tier ancestry resolution: ancestral primary, geom_hash fallback.

Feature: geom_hash_fallback_only.md
"""
import pytest
from oversolved.kernel.query import Repository, AmbiguousQueryError, _is_geom_hash_id


def _make_face_payload(body_id: str, created_by: str, idx: int) -> dict:
    return {
        "type": "flatface",
        "body_id": body_id,
        "created_by": created_by,
        "face_index": idx,
        "centroid": [float(idx), 0.0, 0.0],
        "normal": [0.0, 0.0, 1.0],
    }


def test_is_geom_hash_id_detects_prefixes():
    assert _is_geom_hash_id("@gface_abc123") is True
    assert _is_geom_hash_id("@gedge_abc123") is True
    assert _is_geom_hash_id("@gvertex_abc123") is True
    assert _is_geom_hash_id("@ex1") is False
    assert _is_geom_hash_id("@body_ex1") is False
    assert _is_geom_hash_id("@body_ex1/face0") is False


def test_pure_ancestry_resolution():
    """Hash in by_geom_hash does not affect pure-ancestry queries."""
    repo = Repository()
    payload = _make_face_payload("body1", "ex1", 0)
    repo.register_ancestor(
        ["@body1/face0", "@ex1", "@body1"],
        payload,
        geom_hash="gface_abc",
    )

    from oversolved.kernel.query import make_ancestry_query
    result = repo.query(make_ancestry_query(["@ex1"]))
    assert result is not None
    assert result["created_by"] == "ex1"


def test_hash_not_in_ancestral_key():
    """After registering with geom_hash, no frozenset in ancestral contains a geom_hash string."""
    repo = Repository()
    repo.register_ancestor(
        ["@body1/face0", "@ex1", "@body1"],
        _make_face_payload("body1", "ex1", 0),
        geom_hash="gface_abc",
    )
    repo.register_ancestor(
        ["@body1/edge0", "@ex1", "@body1"],
        {"type": "edge", "body_id": "body1", "created_by": "ex1"},
        geom_hash="gedge_xyz",
    )

    for key in repo.ancestral:
        for tag in key:
            assert not _is_geom_hash_id(tag), (
                f"ancestral key contains geom_hash tag {tag!r}: {key}"
            )


def test_hash_registered_in_by_geom_hash():
    """register_ancestor with geom_hash populates by_geom_hash."""
    repo = Repository()
    repo.register_ancestor(
        ["@body1/face0", "@ex1", "@body1"],
        _make_face_payload("body1", "ex1", 0),
        geom_hash="gface_abc",
    )
    assert "gface_abc" in repo.by_geom_hash
    assert len(repo.by_geom_hash["gface_abc"]) == 1


def test_hash_fallback_when_ancestry_misses():
    """When ancestral query finds nothing, by_geom_hash is consulted as last resort."""
    repo = Repository()
    payload = _make_face_payload("body1", "ex1", 0)
    repo.register_ancestor(
        ["@body1/face0", "@ex1", "@body1"],
        payload,
        geom_hash="gface_hash1",
    )

    # Query using only the hash tag -- no structural ancestor in common
    from oversolved.kernel.query import make_ancestry_query
    result = repo.query(make_ancestry_query(["@gface_hash1"]))
    assert result is not None
    assert result["created_by"] == "ex1"


def test_hash_fallback_with_type_restriction():
    """Hash fallback respects type_restriction."""
    repo = Repository()
    face_payload = _make_face_payload("body1", "ex1", 0)
    repo.register_ancestor(
        ["@body1/face0", "@ex1", "@body1"],
        face_payload,
        geom_hash="gface_hash1",
    )

    from oversolved.kernel.query import make_ancestry_query
    result = repo.query(make_ancestry_query(["@gface_hash1"], "flatface"))
    assert result is not None
    assert result["type"] == "flatface"

    result_wrong_type = repo.query(make_ancestry_query(["@gface_hash1"], "edge"))
    assert result_wrong_type is None


def test_hash_disambiguates_when_ancestry_ambiguous():
    """Two faces share structural ancestry but differ by hash; hash narrows the result."""
    repo = Repository()
    payload_a = _make_face_payload("body1", "ex1", 0)
    payload_b = _make_face_payload("body1", "ex1", 1)

    # Both registered under same @body1 and @ex1 ancestry
    repo.register_ancestor(["@body1/face0", "@ex1", "@body1"], payload_a, geom_hash="gface_aaa")
    repo.register_ancestor(["@body1/face1", "@ex1", "@body1"], payload_b, geom_hash="gface_bbb")

    # Query with only shared ancestors -> ambiguous
    from oversolved.kernel.query import make_ancestry_query
    with pytest.raises(AmbiguousQueryError):
        repo.query(make_ancestry_query(["@ex1"]))

    # Query with hash of face A -> unique
    q = make_ancestry_query(["@gface_aaa", "@ex1", "@body1"])
    result = repo.query(q)
    assert result is not None
    assert result["face_index"] == 0

    # Query with hash of face B -> unique
    q2 = make_ancestry_query(["@gface_bbb", "@ex1", "@body1"])
    result2 = repo.query(q2)
    assert result2 is not None
    assert result2["face_index"] == 1


def test_dedupe_with_no_hash():
    """_dedupe_repo still collapses duplicate registrations after hash is removed from key."""
    from oversolved.kernel.builder import _dedupe_repo

    repo = Repository()
    payload = _make_face_payload("body1", "ex1", 0)
    key = frozenset(["@body1/face0", "@ex1", "@body1"])
    repo.ancestral[key] = ["id1", "id2"]
    repo.elements["id1"] = payload
    repo.elements["id2"] = dict(payload)  # identical payload

    _dedupe_repo(repo)

    assert len(repo.ancestral[key]) == 1
    assert "id1" in repo.elements or "id2" in repo.elements


def test_brep_ancestry_history_still_works():
    """After the hash-demote change, builder correctly tags new faces via created_by."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    r = build({"features": [sk1, ex1]})
    assert r["result"]["ex1"]["status"] == "ok"

    state = r["_build_state"]
    elements = state.checkpoints["ex1"].repo_snapshot["elements"]
    for el in elements.values():
        if isinstance(el, dict) and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                assert cb == "ex1", f"fresh extrude should only have ex1 ancestry, got {cb}"


def test_snapshot_includes_by_geom_hash():
    """_snapshot_with_brep_geometry includes by_geom_hash in the returned dict."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    r = build({"features": [sk1, ex1]})
    assert r["result"]["ex1"]["status"] == "ok"

    state = r["_build_state"]
    snapshot = state.checkpoints["ex1"].repo_snapshot
    assert "by_geom_hash" in snapshot
    assert "version" in snapshot
    assert snapshot["version"] == 2
    # Each hash entry should have at least one element id
    for h, eids in snapshot["by_geom_hash"].items():
        assert len(eids) > 0, f"empty entry for hash {h}"
