"""Geometric-classifier resolver-tier tests (feature: geometric-classifiers.md).

A stable resolver tier between ancestry and the edit-fragile geometry hash:
edit-stable @cls_* tokens (Phase 1: cardinal/axial position vs the body AABB)
disambiguate genuine ancestral siblings (extrude caps, cylinder rims) and, unlike
the geom-hash, survive parametric edits -- the only edit-stable discriminator for
sibling edges, which have no @gnormal_ fallback.

The 2D sketch-surface primitives (classify_surface_*) are tested separately in
test_geometric_classifiers.py; this file covers the new 3D axial classifier and
its wiring into query emission and resolution.
"""

import pytest

from oversolved.kernel.geom_hash import geometry_classifiers
from oversolved.kernel.query import _is_classifier_id, _is_geom_hash_id


# ─── unit: classifier math ───

class TestGeometryClassifiers:
    def test_axial_offset_emits_sign_token(self):
        center, half = [0.0, 0.0, 0.0], [5.0, 5.0, 5.0]
        assert geometry_classifiers([0, 0, 5], center, half) == ["cls_zp"]
        assert geometry_classifiers([0, 0, -5], center, half) == ["cls_zn"]
        assert geometry_classifiers([5, 0, 0], center, half) == ["cls_xp"]

    def test_centered_point_emits_nothing(self):
        # Mid-body on every axis -> no classifier (e.g. a cylinder seam midpoint).
        assert geometry_classifiers([0, 0, 0], [0, 0, 0], [5, 5, 5]) == []

    def test_corner_emits_multiple_axes(self):
        toks = geometry_classifiers([5, 5, 5], [0, 0, 0], [5, 5, 5])
        assert set(toks) == {"cls_xp", "cls_yp", "cls_zp"}

    def test_degenerate_axis_skipped(self):
        # A flat profile (zero z extent) classifies only in x/y.
        assert geometry_classifiers([5, 0, 0], [0, 0, 0], [5, 5, 0.0]) == ["cls_xp"]

    def test_below_threshold_emits_nothing(self):
        # Inside half the half-extent -> not "clearly" on a side.
        assert geometry_classifiers([0, 0, 2.0], [0, 0, 0], [5, 5, 5]) == []

    def test_translation_and_scale_stable_sign(self):
        a = geometry_classifiers([0, 0, 10], [0, 0, 5], [5, 5, 5])
        b = geometry_classifiers([0, 0, 30], [0, 0, 15], [15, 15, 15])
        assert a == b == ["cls_zp"]


class TestClassifierTokenPredicate:
    def test_recognises_cls_prefix(self):
        assert _is_classifier_id("@cls_zp")
        assert _is_classifier_id("@cls_xn")

    def test_rejects_non_classifier(self):
        assert not _is_classifier_id("@gface_abc")
        assert not _is_classifier_id("@ex1")
        assert not _is_classifier_id("@sk1/left")

    def test_classifier_is_not_a_geom_hash(self):
        # The partitions must be disjoint: @cls_* is neither ancestry nor hash.
        assert not _is_geom_hash_id("@cls_zp")


# ─── unit: AABB frame ───

def test_body_aabb_frame_centers_a_box():
    pytest.importorskip("OCP.BRepPrimAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.geometry_tessellation import body_aabb_frame

    box = BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Solid()
    center, half = body_aabb_frame(box)
    assert center == pytest.approx([5.0, 10.0, 15.0])
    assert half == pytest.approx([5.0, 10.0, 15.0])


# ─── helpers for the wired-resolution tests ───

from solver_helpers import rect_sketch_spec, extrude_spec  # noqa: E402


def _parse(query):
    from oversolved.kernel.query import _parse_ancestry
    return _parse_ancestry(query)


def _rebuild(query, *, keep_hash=True, keep_cls=True):
    """Re-emit a query keeping/dropping the geom-hash and/or classifier tokens."""
    from oversolved.kernel.query import (
        _parse_ancestry, make_ancestry_query, _is_geom_hash_id, _is_classifier_id,
    )
    ids, t = _parse_ancestry(query)
    kept = [
        i for i in ids
        if (keep_hash or not _is_geom_hash_id(i)) and (keep_cls or not _is_classifier_id(i))
    ]
    return make_ancestry_query(kept, t)


def _cls_tokens(query):
    from oversolved.kernel.query import _parse_ancestry, _is_classifier_id
    ids, _ = _parse_ancestry(query)
    return [i for i in ids if _is_classifier_id(i)]


def _top_plane_box(w=10.0, h=10.0, d=4.0):
    """Build a box on the top plane (caps are +Z / -Z) -> (repo, body_out)."""
    from oversolved.kernel.builder import build, _repo_from_snapshot
    sk = rect_sketch_spec(w=w, h=h, sketch_id="sk1", plane="@builtin_plane_top")
    ex = extrude_spec("sk1", "ex1", distance=d)
    r = build({"features": [sk, ex]})
    assert r["result"]["ex1"]["status"] == "ok"
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)
    return repo, r["bodies"]["body_ex1"]


def _cap_queries(body_out):
    """The ancestral-sibling face group: faces sharing identical ancestry.

    For a single-profile extrude this is exactly the two caps (the four side
    faces are each lineage-distinct). Found by ancestry, so it is independent of
    how the sketch plane maps onto world axes.
    """
    from collections import defaultdict
    groups: dict[str, list[str]] = defaultdict(list)
    for q in body_out["mesh"]["face_queries"]:
        groups[_rebuild(q, keep_hash=False, keep_cls=False)].append(q)
    siblings = [qs for qs in groups.values() if len(qs) >= 2]
    return max(siblings, key=len) if siblings else []


# ─── test 1: caps carry opposite axial classifiers ───

def test_classifier_tokens_emitted_on_caps():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    _repo, body_out = _top_plane_box()
    caps = _cap_queries(body_out)
    assert len(caps) == 2
    # Each cap carries exactly one classifier; the two are opposite signs on the
    # same axis (the extrude axis). Which world axis depends on the sketch plane.
    toks = [_cls_tokens(q) for q in caps]
    assert all(len(t) == 1 for t in toks), toks
    a, b = sorted(t[0] for t in toks)
    assert a[:-1] == b[:-1] and {a[-1], b[-1]} == {"n", "p"}, (a, b)


# ─── test 2: caps resolve by classifier alone (geom hash stripped) ───

def test_caps_resolve_by_classifier_without_geom_hash():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _top_plane_box()
    caps = _cap_queries(body_out)
    assert len(caps) == 2

    for q in caps:
        # Ancestry + classifier (no geom hash): resolves to exactly one cap.
        resolved = repo.query(_rebuild(q, keep_hash=False, keep_cls=True))
        assert resolved is not None, f"cap did not resolve by classifier: {q!r}"
        assert resolved.get("type") in ("face", "flatface")
        # Drop the classifier too and the two caps are indistinguishable: ambiguous.
        from oversolved.kernel.query import AmbiguousQueryError
        with pytest.raises(AmbiguousQueryError):
            repo.query(_rebuild(q, keep_hash=False, keep_cls=False))


# ─── test 7: queries with no classifier token are unaffected ───

def test_existing_queries_unaffected_by_classifier_tier():
    pytest.importorskip("OCP.gp")
    pytest.importorskip("cadquery")
    repo, body_out = _top_plane_box()
    # A pre-feature query carries no @cls_ token; the tier must be skipped and the
    # full query must still resolve exactly as before (here via the geom hash).
    for q in body_out["mesh"]["face_queries"]:
        no_cls = _rebuild(q, keep_hash=True, keep_cls=False)
        assert _cls_tokens(no_cls) == []
        assert repo.query(no_cls) is not None, f"classifier-free query regressed: {no_cls!r}"
