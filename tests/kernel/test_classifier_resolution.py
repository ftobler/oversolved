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
