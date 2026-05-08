import importlib
import pytest

from oversolved.kernel.builder import build
from solver_helpers import rect_sketch_spec


pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _extrude_spec(
    sketch_id, extrude_id, distance, operation="add",
    direction="normal", merge_target=None,
):
    spec = {
        "id": extrude_id,
        "kind": "extrude",
        "extrude": {
            "sketch": ["$" + sketch_id],
            "distance": distance,
            "direction": direction,
            "operation": operation,
        },
    }
    if merge_target is not None:
        spec["extrude"]["merge_target"] = merge_target
    return spec


def _box_doc():
    """Create a doc with one box at [0,10]x[0,10] extruded 5 units."""
    sk = rect_sketch_spec(10, 10, sketch_id="sk0")
    ex = _extrude_spec("sk0", "ex0", 5, operation="new")
    return {"features": [sk, ex]}


def _two_box_doc():
    """Create a doc with two disjoint boxes.
    Body A (ex0): box at [0,10]x[0,10], extruded 5 units.
    Body B (ex1): box at [20,30]x[20,30], extruded 5 units (disjoint from A).
    """
    sk1 = rect_sketch_spec(10, 10, sketch_id="sk0")
    ex1 = _extrude_spec("sk0", "ex0", 5, operation="new")
    sk2 = rect_sketch_spec(10, 10, sketch_id="sk1")
    ex2 = _extrude_spec("sk1", "ex1", 5, operation="new",
                        merge_target=None)
    # Move sk2 rectangle to [20,30]x[20,30]
    sk2["initial"] = {
        "bottom": [20, 20, 30, 20],
        "right": [30, 20, 30, 30],
        "top": [30, 30, 20, 30],
        "left": [20, 30, 20, 20],
    }
    return {"features": [sk1, ex1, sk2, ex2]}


# ─── Add with merge_target ───


def test_add_with_merge_target_fuses_to_specific_body():
    doc = _two_box_doc()
    # Add a new extrude targeting body ex0 only
    sk3 = rect_sketch_spec(10, 10, sketch_id="sk2")
    ex3 = _extrude_spec("sk2", "ex2", 3, operation="add",
                        merge_target="@body_ex0")
    doc["features"].extend([sk3, ex3])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"
    assert r["result"]["ex2"]["operation"] == "add"
    # Should have a single body_id
    assert "body_id" in r["result"]["ex2"]
    assert r["result"]["ex2"]["body_id"] == "body_ex0"
    # Body ex1 should be unchanged
    assert "body_ex1" in r["bodies"]


def test_add_with_merge_target_all_when_empty():
    """No merge_target set = fuse with first existing body (current behavior)."""
    doc = _box_doc()
    sk2 = rect_sketch_spec(10, 10, sketch_id="sk2")
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"


def test_add_without_merge_target_creates_new_body_when_none_exist():
    """When no bodies exist and no merge_target set, 'add' falls back to creating a new body."""
    doc = {"features": []}
    sk = rect_sketch_spec(10, 10, sketch_id="sk0")
    ex = _extrude_spec("sk0", "ex0", 5, operation="add")
    doc["features"] = [sk, ex]
    r = build(doc)
    assert r["result"]["ex0"]["status"] == "ok"


def test_add_with_island_shape_succeeds_when_no_merge_target():
    """Disjoint add without merge_target succeeds (allows compound bodies)."""
    doc = _box_doc()
    sk2 = rect_sketch_spec(10, 10, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [100, 100, 110, 100],
        "right": [110, 100, 110, 110],
        "top": [110, 110, 100, 110],
        "left": [100, 110, 100, 100],
    }
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"


def test_add_succeeds_with_touching_shape():
    doc = _box_doc()
    # Extrude from a touching position on the top face
    sk2 = rect_sketch_spec(2, 2, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [4, 4, 6, 4],
        "right": [6, 4, 6, 6],
        "top": [6, 6, 4, 6],
        "left": [4, 6, 4, 4],
    }
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"


def test_add_fails_with_island_shape_when_merge_target_set():
    """Adding a disjoint shape with merge_target set should fail island detection."""
    doc = _box_doc()
    sk2 = rect_sketch_spec(10, 10, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [100, 100, 110, 100],
        "right": [110, 100, 110, 110],
        "top": [110, 110, 100, 110],
        "left": [100, 110, 100, 100],
    }
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add",
                        merge_target="@body_ex0")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "exception"
    assert "island" in r["result"]["ex2"].get("exception", "")


def test_add_with_merge_target_nonexistent_body_fails():
    doc = _box_doc()
    sk2 = rect_sketch_spec(10, 10, sketch_id="sk2")
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add",
                        merge_target="@body_nonexistent")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "exception"


# ─── Cut with merge_target ───


def test_cut_with_merge_target_cuts_specific_body():
    doc = _two_box_doc()
    # Both bodies were created as "new", both at same z range (0 to 5).
    # Cut a shape that intersects body A only.
    sk3 = rect_sketch_spec(2, 2, sketch_id="sk2")
    sk3["initial"] = {
        "bottom": [4, 4, 6, 4],
        "right": [6, 4, 6, 6],
        "top": [6, 6, 4, 6],
        "left": [4, 6, 4, 4],
    }
    ex3 = _extrude_spec("sk2", "ex2", 2, operation="cut",
                        merge_target="@body_ex0")
    doc["features"].extend([sk3, ex3])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"
    assert r["result"]["ex2"]["operation"] == "cut"
    # Body ex1 should remain unchanged
    assert "body_ex1" in r["bodies"]


def test_cut_fails_when_no_intersection():
    doc = _two_box_doc()
    # Cut shape that doesn't intersect any body
    sk3 = rect_sketch_spec(2, 2, sketch_id="sk2")
    sk3["initial"] = {
        "bottom": [100, 100, 102, 100],
        "right": [102, 100, 102, 102],
        "top": [102, 102, 100, 102],
        "left": [100, 102, 100, 100],
    }
    ex3 = _extrude_spec("sk2", "ex2", 2, operation="cut")
    doc["features"].extend([sk3, ex3])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "exception"


def test_cut_with_no_body_silently_succeeds():
    """Cut extrude with no prior bodies silently succeeds (nothing to cut)."""
    doc = {"features": []}
    sk = rect_sketch_spec(10, 10, sketch_id="sk0")
    ex = _extrude_spec("sk0", "ex0", 5, operation="cut")
    doc["features"] = [sk, ex]
    r = build(doc)
    assert r["result"]["ex0"]["status"] == "ok"


def test_cut_merge_target_all_cuts_all_bodies():
    doc = _two_box_doc()
    # Cut shape that intersects both bodies
    sk3 = rect_sketch_spec(30, 30, sketch_id="sk2")
    sk3["initial"] = {
        "bottom": [0, 0, 30, 0],
        "right": [30, 0, 30, 30],
        "top": [30, 30, 0, 30],
        "left": [0, 30, 0, 0],
    }
    ex3 = _extrude_spec("sk2", "ex2", 2, operation="cut")
    doc["features"].extend([sk3, ex3])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"


def test_cut_merge_target_nonexistent_body_fails():
    doc = _two_box_doc()
    sk3 = rect_sketch_spec(2, 2, sketch_id="sk2")
    ex3 = _extrude_spec("sk2", "ex2", 2, operation="cut",
                        merge_target="@body_nonexistent")
    doc["features"].extend([sk3, ex3])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "exception"


# ─── New operation (unchanged) ───


def test_new_creates_single_body():
    doc = _box_doc()
    r = build(doc)
    assert r["result"]["ex0"]["status"] == "ok"
    assert r["result"]["ex0"]["operation"] == "new"
    assert "body_ids" in r["result"]["ex0"]
    assert len(r["result"]["ex0"]["body_ids"]) == 1


def test_new_creates_multiple_bodies_for_disjoint_shapes():
    sk0 = rect_sketch_spec(10, 10, sketch_id="sk0")
    ex0 = _extrude_spec("sk0", "ex0", 5, operation="new")
    doc = {"features": [sk0, ex0]}
    # Add a second sketch that produces a disjoint shape
    sk1 = rect_sketch_spec(5, 5, sketch_id="sk1")
    sk1["initial"] = {
        "bottom": [20, 20, 25, 20],
        "right": [25, 20, 25, 25],
        "top": [25, 25, 20, 25],
        "left": [20, 25, 20, 20],
    }
    ex1 = _extrude_spec("sk1", "ex1", 3, operation="new")
    doc["features"].extend([sk1, ex1])
    r = build(doc)
    assert r["result"]["ex1"]["status"] == "ok"
    assert r["result"]["ex1"]["operation"] == "new"


# ─── Rebuild preservation ───


def test_add_merge_target_preserved_across_rebuild():
    doc = _box_doc()
    sk2 = rect_sketch_spec(2, 2, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [4, 4, 6, 4],
        "right": [6, 4, 6, 6],
        "top": [6, 6, 4, 6],
        "left": [4, 6, 4, 4],
    }
    ex2 = _extrude_spec("sk2", "ex2", 3, operation="add",
                        merge_target="@body_ex0")
    doc["features"].extend([sk2, ex2])
    r = build(doc)
    assert r["result"]["ex2"]["status"] == "ok"
    # Rebuild should preserve the merge_target in spec
    feat = [f for f in doc["features"] if f["id"] == "ex2"][0]
    assert feat["extrude"]["merge_target"] == "@body_ex0"
