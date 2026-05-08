import importlib
import pytest

from oversolved.kernel.builder import build
from solver_helpers import rect_sketch_spec


pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _revolve_spec(
    sketch_id, revolve_id, angle=360.0, operation="add",
    merge_target=None,
):
    spec = {
        "id": revolve_id,
        "kind": "revolve",
        "revolve": {
            "sketch": ["$" + sketch_id],
            "angle": angle,
            "axis_origin": [0, 0, 0],
            "axis_direction": [0, 1, 0],
            "operation": operation,
        },
    }
    if merge_target is not None:
        spec["revolve"]["merge_target"] = merge_target
    return spec


def _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id="sk1"):
    spec = rect_sketch_spec(w=w, h=h, sketch_id=sketch_id)
    for key in spec["initial"]:
        spec["initial"][key] = [
            spec["initial"][key][0] + offset_x,
            spec["initial"][key][1],
            spec["initial"][key][2] + offset_x,
            spec["initial"][key][3],
        ]
    return spec


def _body_a_doc():
    """Create a doc with one revolve body.
    Rectangle at [1,0]x[3,1] revolved 360 around y-axis -> body_A.
    """
    sk = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id="sk0")
    rev = _revolve_spec("sk0", "rev0", operation="new")
    return {"features": [sk, rev]}


def _two_body_doc():
    """Create a doc with two disjoint revolve bodies.
    Body A (rev0): rectangle [1,0]x[3,1] revolved 360 around y-axis.
    Body B (rev1): rectangle [10,0]x[12,1] revolved 360 around y-axis (disjoint).
    """
    sk1 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id="sk0")
    rev1 = _revolve_spec("sk0", "rev0", operation="new")
    sk2 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=10.0, sketch_id="sk1")
    rev2 = _revolve_spec("sk1", "rev1", operation="new")
    return {"features": [sk1, rev1, sk2, rev2]}


# ─── Add with merge_target ───


def test_revolve_add_with_merge_target_fuses_to_specific_body():
    doc = _two_body_doc()
    sk3 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=2.0, sketch_id="sk2")
    rev3 = _revolve_spec("sk2", "rev2", operation="add",
                         merge_target="@body_rev0")
    doc["features"].extend([sk3, rev3])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "ok"
    assert r["result"]["rev2"]["operation"] == "add"
    assert r["result"]["rev2"]["body_id"] == "body_rev0"
    assert "body_rev1" in r["bodies"]


def test_revolve_add_merge_target_all_when_empty():
    doc = _body_a_doc()
    sk2 = _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=2.0, sketch_id="sk2")
    rev2 = _revolve_spec("sk2", "rev2", operation="add")
    doc["features"].extend([sk2, rev2])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "ok"


def test_revolve_add_without_merge_target_creates_new_body_when_none_exist():
    doc = {"features": []}
    sk = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id="sk0")
    rev = _revolve_spec("sk0", "rev0", operation="add")
    doc["features"] = [sk, rev]
    r = build(doc)
    assert r["result"]["rev0"]["status"] == "ok"


def test_revolve_add_fails_with_island_shape_when_merge_target_set():
    doc = _body_a_doc()
    sk2 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=20.0, sketch_id="sk2")
    rev2 = _revolve_spec("sk2", "rev2", operation="add",
                         merge_target="@body_rev0")
    doc["features"].extend([sk2, rev2])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "exception"
    assert "island" in r["result"]["rev2"].get("exception", "")


def test_revolve_add_with_merge_target_nonexistent_body_fails():
    doc = _body_a_doc()
    sk2 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=2.0, sketch_id="sk2")
    rev2 = _revolve_spec("sk2", "rev2", operation="add",
                         merge_target="@body_nonexistent")
    doc["features"].extend([sk2, rev2])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "exception"


# ─── Cut with merge_target ───


def test_revolve_cut_with_merge_target_cuts_specific_body():
    doc = _two_body_doc()
    sk3 = _rect_sketch_at_offset(w=2.0, h=0.5, offset_x=1.0, sketch_id="sk2")
    rev3 = _revolve_spec("sk2", "rev2", operation="cut",
                         merge_target="@body_rev0")
    doc["features"].extend([sk3, rev3])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "ok"
    assert r["result"]["rev2"]["operation"] == "cut"
    assert "body_rev1" in r["bodies"]


def test_revolve_cut_fails_when_no_intersection():
    doc = _two_body_doc()
    sk3 = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=50.0, sketch_id="sk2")
    rev3 = _revolve_spec("sk2", "rev2", operation="cut")
    doc["features"].extend([sk3, rev3])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "exception"


def test_revolve_cut_with_no_body_silently_succeeds():
    doc = {"features": []}
    sk = _rect_sketch_at_offset(w=2.0, h=1.0, offset_x=1.0, sketch_id="sk0")
    rev = _revolve_spec("sk0", "rev0", operation="cut")
    doc["features"] = [sk, rev]
    r = build(doc)
    assert r["result"]["rev0"]["status"] == "ok"


def test_revolve_cut_merge_target_all_cuts_all_bodies():
    doc = _two_body_doc()
    sk3 = _rect_sketch_at_offset(w=30.0, h=1.0, offset_x=0.0, sketch_id="sk2")
    rev3 = _revolve_spec("sk2", "rev2", operation="cut")
    doc["features"].extend([sk3, rev3])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "ok"


def test_revolve_cut_merge_target_nonexistent_body_fails():
    doc = _two_body_doc()
    sk3 = _rect_sketch_at_offset(w=2.0, h=0.5, offset_x=1.0, sketch_id="sk2")
    rev3 = _revolve_spec("sk2", "rev2", operation="cut",
                         merge_target="@body_nonexistent")
    doc["features"].extend([sk3, rev3])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "exception"


# ─── New operation (unchanged) ───


def test_revolve_new_creates_independent_body():
    doc = _body_a_doc()
    r = build(doc)
    assert r["result"]["rev0"]["status"] == "ok"
    assert r["result"]["rev0"]["operation"] == "new"


# ─── Rebuild preservation ───


def test_revolve_merge_target_preserved_across_rebuild():
    doc = _body_a_doc()
    sk2 = _rect_sketch_at_offset(w=1.0, h=1.0, offset_x=2.0, sketch_id="sk2")
    rev2 = _revolve_spec("sk2", "rev2", operation="add",
                         merge_target="@body_rev0")
    doc["features"].extend([sk2, rev2])
    r = build(doc)
    assert r["result"]["rev2"]["status"] == "ok"
    feat = [f for f in doc["features"] if f["id"] == "rev2"][0]
    assert feat["revolve"]["merge_target"] == "@body_rev0"
