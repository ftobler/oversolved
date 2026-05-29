"""B-rep diff coverage for geometry-mutating features beyond boolean cut/union.

Verifies that hole, boolean intersection, fillet, chamfer, linear array (merged),
and mirror (merged) populate Body.brep_diff so the @created_by ancestry rewrite in
builder.py tags new faces/edges to the modifying feature rather than the body's
original creator.

See feature/brep-diff-feature-coverage.md.
"""

import importlib
import pytest

from solver_helpers import (
    rect_sketch_spec, extrude_spec, box_extrude_spec,
    full_rect_extrude_spec, point_sketch_spec, hole_spec,
)

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _created_by_set(r, feature_id, body_id, types):
    """Collect the set of @created_by tags across a body's registered sub-shapes."""
    state = r["_build_state"]
    elements = state.checkpoints[feature_id].repo_snapshot["elements"]
    out: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") in types and el.get("body_id") == body_id:
            cb = el.get("created_by")
            if cb:
                out.add(cb)
    return out


_FACE_TYPES = ("face", "flatface", "cylinderface")


# ── Stage 2: hole ──


def _box_with_hole_spec():
    return {"features": [
        rect_sketch_spec(w=50, h=50, sketch_id="sk1"),
        extrude_spec("sk1", "ex1", distance=30.0),
        point_sketch_spec([(25, 25)], sketch_id="pts"),
        hole_spec("pts", "hl1", diameter=10.0, depth_mode="through_all"),
    ]}


def test_hole_body_carries_brep_diff():
    from oversolved.kernel.builder import build

    r = build(_box_with_hole_spec())
    assert r["result"]["hl1"]["status"] == "ok", r["result"]["hl1"]

    body = r["_build_state"].checkpoints["hl1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "hole body should have brep_diff attached"
    assert len(body.brep_diff.new_faces) > 0, "hole should produce at least one new wall face"


def test_hole_walls_tagged_with_hole_feature_id():
    from oversolved.kernel.builder import build

    r = build(_box_with_hole_spec())
    assert r["result"]["hl1"]["status"] == "ok", r["result"]["hl1"]

    cb = _created_by_set(r, "hl1", "body_ex1", _FACE_TYPES)
    assert "ex1" in cb, f"expected original extrude to still own outer faces, got {cb}"
    assert "hl1" in cb, f"expected hole feature to own at least one wall face, got {cb}"


# ── Stage 3: boolean intersection ──


def _two_overlapping_boxes_intersection():
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    sk2 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [5, 5, 15, 5], "right": [15, 5, 15, 15],
        "top": [15, 15, 5, 15], "left": [5, 15, 5, 5],
    }
    sk2["constraints"] = [c for c in sk2["constraints"] if c["id"] not in ("c9", "c10")]
    sk2["constraints"].extend([
        {"id": "c9", "kind": "length", "target": {"entity": "bottom"}, "value": 10.0},
        {"id": "c10", "kind": "length", "target": {"entity": "left"}, "value": 10.0},
    ])
    ex2 = extrude_spec("sk2", "ex2", distance=10.0, operation="new")
    bool1 = {
        "id": "bool1", "kind": "boolean",
        "boolean": {"operation": "intersect", "target": "@ex1", "tools": ["@ex2"]},
    }
    return {"features": [sk1, ex1, sk2, ex2, bool1]}


def test_boolean_intersection_body_carries_brep_diff():
    from oversolved.kernel.builder import build

    r = build(_two_overlapping_boxes_intersection())
    assert r["result"]["bool1"]["status"] == "ok", f"intersection did not apply: {r['result']['bool1']}"

    body = r["_build_state"].checkpoints["bool1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "intersection body should have brep_diff attached"


def test_boolean_intersection_faces_tagged_with_intersection_feature():
    from oversolved.kernel.builder import build

    r = build(_two_overlapping_boxes_intersection())
    assert r["result"]["bool1"]["status"] == "ok", f"intersection did not apply: {r['result']['bool1']}"

    cb = _created_by_set(r, "bool1", "body_ex1", _FACE_TYPES)
    assert "bool1" in cb, f"expected intersection feature to own at least one face, got {cb}"


# ── Stage 1: fillet / chamfer ──


def test_fillet_populates_brep_diff_with_new_face():
    from oversolved.kernel.builder import build

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": ["?body_ex1:edge:0"], "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fil1"]["status"] == "ok", r["result"]["fil1"]

    body = r["_build_state"].checkpoints["fil1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "fillet body should carry brep_diff"
    assert len(body.brep_diff.new_faces) >= 1, "fillet should generate at least one new surface"


def test_fillet_new_face_tagged_with_fillet_feature_id():
    from oversolved.kernel.builder import build

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": ["?body_ex1:edge:0"], "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fil1"]["status"] == "ok", r["result"]["fil1"]

    cb = _created_by_set(r, "fil1", "body_ex1", _FACE_TYPES)
    assert "ex1" in cb, f"inherited box faces should keep @ex1, got {cb}"
    assert "fil1" in cb, f"fillet surface should be tagged @fil1, got {cb}"


def test_chamfer_populates_brep_diff_and_tags_feature():
    from oversolved.kernel.builder import build

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "ch1", "kind": "chamfer", "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"], "distance": 1.0,
    })
    r = build(spec)
    assert r["result"]["ch1"]["status"] == "ok", r["result"]["ch1"]

    body = r["_build_state"].checkpoints["ch1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None
    assert len(body.brep_diff.new_faces) >= 1
    cb = _created_by_set(r, "ch1", "body_ex1", _FACE_TYPES)
    assert "ch1" in cb, f"chamfer surface should be tagged @ch1, got {cb}"


def test_fillet_inherited_faces_keep_original_created_by():
    from oversolved.kernel.builder import build

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": ["?body_ex1:edge:0"], "radius": 1.0,
    })
    r = build(spec)
    assert r["result"]["fil1"]["status"] == "ok", r["result"]["fil1"]

    body = r["_build_state"].checkpoints["fil1"].body_store_snapshot.get("body_ex1")
    # Most faces are untouched (inherited); only the filleted edge yields a new face.
    assert len(body.brep_diff.inherited_faces) >= 4


def test_fillet_with_no_resolvable_edges_is_partial_no_crash():
    from oversolved.kernel.builder import build

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append({
        "id": "fil1", "kind": "fillet", "label": "Fillet",
        "edges": ["?body_ex1:edge:9999"], "radius": 1.0,
    })
    r = build(spec)
    # No resolvable edge -> solver reports exception, but must not crash the build.
    assert r["result"]["fil1"]["status"] in ("exception", "partial")


# ── Stage 4: array / mirror ──


def _abutting_linear_array_spec(box_w=5.0, count_x=2):
    """Linear array with pitch == box width so copies abut and create a seam."""
    spec = box_extrude_spec(w=box_w, h=5, d=5, extrude_id="ex1")
    spec["features"].append({
        "id": "arr1", "kind": "array",
        "array": {
            "source_body": "ex1", "mode": "linear",
            "count_x": count_x, "pitch_x": box_w,
            "direction_x": [1, 0, 0], "operation": "add",
            "include_source": True,
        },
    })
    return spec


def test_linear_array_merged_carries_brep_diff():
    from oversolved.kernel.builder import build

    r = build(_abutting_linear_array_spec())
    assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
    body = r["_build_state"].checkpoints["arr1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "merged array body should carry brep_diff"


def test_linear_array_seam_tagged_with_array_feature():
    from oversolved.kernel.builder import build

    r = build(_abutting_linear_array_spec())
    assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
    cb = _created_by_set(r, "arr1", "body_ex1", _FACE_TYPES)
    assert "arr1" in cb, f"array feature should own at least one merged face, got {cb}"


def test_array_no_merge_leaves_body_with_created_by_array():
    from oversolved.kernel.builder import build

    spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="ex1")
    spec["features"].append({
        "id": "arr1", "kind": "array",
        "array": {
            "source_body": "ex1", "mode": "linear",
            "count_x": 3, "pitch_x": 20,
            "direction_x": [1, 0, 0], "operation": "new",
            "include_source": True,
        },
    })
    r = build(spec)
    assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
    body = r["_build_state"].checkpoints["arr1"].body_store_snapshot.get("body_arr1")
    assert body is not None
    assert body.created_by == "arr1"
    # New-body path: no boolean diff expected.
    assert body.brep_diff is None


def _mirror_merge_spec():
    """Box from x in [5,15], mirror across YZ plane at x=5 so halves abut and merge."""
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    sk1["initial"] = {
        "bottom": [5, 0, 15, 0], "right": [15, 0, 15, 10],
        "top": [15, 10, 5, 10], "left": [5, 10, 5, 0],
    }
    sk1["constraints"] = [c for c in sk1["constraints"] if c["id"] not in ("c9", "c10")]
    sk1["constraints"].extend([
        {"id": "c9", "kind": "length", "target": {"entity": "bottom"}, "value": 10.0},
        {"id": "c10", "kind": "length", "target": {"entity": "left"}, "value": 10.0},
    ])
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    mir1 = {
        "id": "mir1", "kind": "mirror",
        "mirror": {"body": "@ex1", "plane": "@builtin_plane_right",
                   "keep_original": True, "merge": True},
    }
    return {"features": [sk1, ex1, mir1]}


def test_mirror_merge_carries_brep_diff_and_tags_feature():
    from oversolved.kernel.builder import build

    r = build(_mirror_merge_spec())
    assert r["result"]["mir1"]["status"] == "ok", f"mirror did not apply: {r['result']['mir1']}"
    body = r["_build_state"].checkpoints["mir1"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "merged mirror body should carry brep_diff"
    cb = _created_by_set(r, "mir1", "body_ex1", _FACE_TYPES)
    assert "mir1" in cb, f"mirror feature should own at least one merged face, got {cb}"
