"""Lineage stable-keying tests (feature: lineage-stable-keying.md).

Per-face/edge lineage was inert in the normal build path: _copy_body dropped the
lineage dicts AND the maps were keyed by OCC subshape hash, which _copy_shape
invalidates. These tests pin the fix: lineage is re-keyed on the copy-stable
geometry hash, preserved across _copy_body, and threaded into both the query and
the registration key so sibling faces resolve by their own ancestry.
"""

import pytest


def _face_geom_hashes(occ_shape) -> list[str]:
    """Geometry-hash key for every face of a shape (copy-stable identity)."""
    from cadquery.occ_impl import shapes as cq_shapes
    from oversolved.kernel.cadquery_ops import _compute_face_centroid, _compute_face_normal
    from oversolved.kernel.geom_hash import face_geometry_hash
    cq = cq_shapes.Shape.cast(occ_shape)
    return sorted(
        face_geometry_hash(_compute_face_centroid(f), _compute_face_normal(f))
        for f in cq.Faces()
    )


def _face_subshape_hashes(occ_shape) -> set[str]:
    """The OCC subshape hash the old keying used (copy-fragile)."""
    from cadquery.occ_impl import shapes as cq_shapes
    cq = cq_shapes.Shape.cast(occ_shape)
    return {str(hash(f.wrapped)) for f in cq.Faces()}


# ─── test 3: _copy_body preserves lineage ───

def test_copy_body_preserves_lineage():
    """A Body with non-empty lineage round-trips through _copy_body intact."""
    from oversolved.kernel.builder import _copy_body
    from oversolved.kernel.types3d import Body

    body = Body(id="body_ex1", created_by="ex1")
    body.face_lineage = {"gface_aaa": ["@sk1/bottom"], "gface_bbb": ["@sk1/top"]}
    body.edge_lineage = {"gedge_ccc": ["@sk1/left"]}

    copy = _copy_body(body)

    assert copy.face_lineage == body.face_lineage
    assert copy.edge_lineage == body.edge_lineage
    # Deep copy: mutating the copy must not touch the original.
    copy.face_lineage["gface_aaa"].append("@sk1/right")
    assert body.face_lineage["gface_aaa"] == ["@sk1/bottom"]


# ─── test 4: geom-hash keys survive a shape copy ───

def test_lineage_key_stable_across_copy():
    """Geom-hash keys match before/after _copy_shape; subshape hashes do not.

    This is the core reason the lineage maps are re-keyed on the geometry hash:
    the previous subshape-hash keys are invalidated by BRepBuilderAPI copy.
    """
    pytest.importorskip("OCP.BRepPrimAPI")
    pytest.importorskip("cadquery")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.builder import _copy_shape

    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Solid()

    before_geom = _face_geom_hashes(box)
    before_sub = _face_subshape_hashes(box)

    copied = _copy_shape(box)
    assert copied is not None

    after_geom = _face_geom_hashes(copied)
    after_sub = _face_subshape_hashes(copied)

    assert before_geom == after_geom, "geom-hash keys must survive a shape copy"
    # The old keying scheme would have lost every key here.
    assert before_sub.isdisjoint(after_sub), (
        "subshape hashes are expected to change across a copy (regression guard)"
    )
