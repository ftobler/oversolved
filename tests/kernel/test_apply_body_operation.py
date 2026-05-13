"""Tests for the _apply_body_operation shared helper."""
import importlib
import pytest

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _make_box_shape(x0=0, y0=0, z0=0, x1=5, y1=5, z1=5):
    """Return a CadQuery solid box shape."""
    import cadquery as cq
    box = cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0)
    solids = box.val()
    return solids


def _make_body_store(shape, body_id="body_b0", feature_id="b0", sketch_id="sk0"):
    """Build a minimal body_store with one body."""
    from oversolved.kernel.types3d import Body
    body = Body(id=body_id, created_by=feature_id, shape=shape, sketch_id=sketch_id)
    return {body_id: body}


def _call_helper(tool_shape, body_store, operation, merge_target=None,
                 body_id="body_feat1", feature_id="feat1", sketch_id="sk0",
                 op_name="test"):
    from oversolved.kernel.solver_features import _apply_body_operation
    return _apply_body_operation(
        tool_shape, body_store, operation, merge_target,
        body_id, feature_id, sketch_id, op_name=op_name,
    )


# ─── Result dict structure tests ───


def test_new_operation_creates_body_in_store():
    tool = _make_box_shape()
    body_store: dict = {}
    result = _call_helper(tool, body_store, operation="new")
    assert result["status"] == "ok"
    assert result["operation"] == "new"
    assert "body_id" in result
    assert "body_ids" in result
    assert result["body_id"] in body_store


def test_add_operation_with_no_existing_body_creates_new():
    tool = _make_box_shape()
    body_store: dict = {}
    result = _call_helper(tool, body_store, operation="add")
    assert result["status"] == "ok"
    assert result["operation"] == "add"
    assert result["body_id"] in body_store


def test_add_operation_fuses_with_existing_touching_body():
    import cadquery as cq
    # Two touching boxes: [0,5]^3 and [5,10]x[0,5]x[0,5]
    box_a = cq.Workplane("XY").box(5, 5, 5).val()
    tool = cq.Workplane("XY").transformed(offset=(5, 0, 0)).box(5, 5, 5).val()
    body_store = _make_body_store(box_a, body_id="body_b0")
    result = _call_helper(tool, body_store, operation="add")
    assert result["status"] == "ok"
    assert result["operation"] == "add"
    assert result["body_id"] == "body_b0"


def test_cut_operation_removes_intersection():
    import cadquery as cq
    # Existing body: box 5x5x5 at origin
    existing = cq.Workplane("XY").box(5, 5, 5).val()
    # Tool: box that overlaps the existing body
    tool = cq.Workplane("XY").box(2, 2, 6).val()
    body_store = _make_body_store(existing)
    result = _call_helper(tool, body_store, operation="cut")
    assert result["status"] == "ok"
    assert result["operation"] == "cut"


def test_cut_operation_fails_when_no_intersection():
    import cadquery as cq
    existing = cq.Workplane("XY").box(5, 5, 5).val()
    # Tool far away: no intersection
    tool = cq.Workplane("XY").transformed(offset=(100, 100, 100)).box(2, 2, 2).val()
    body_store = _make_body_store(existing)
    with pytest.raises(ValueError, match="cut does not intersect"):
        _call_helper(tool, body_store, operation="cut")


def test_cut_with_empty_store_and_no_merge_target_returns_ok():
    import cadquery as cq
    tool = cq.Workplane("XY").box(5, 5, 5).val()
    body_store: dict = {}
    result = _call_helper(tool, body_store, operation="cut", merge_target=None)
    assert result["status"] == "ok"
    assert result["operation"] == "cut"


def test_add_with_nonexistent_merge_target_raises():
    import cadquery as cq
    tool = cq.Workplane("XY").box(5, 5, 5).val()
    body_store: dict = {}
    with pytest.raises(ValueError, match="body_nonexistent"):
        _call_helper(tool, body_store, operation="add", merge_target="@body_nonexistent")


# ─── op_name prefix tests ───


def test_error_prefix_uses_op_name_extrude():
    import cadquery as cq
    tool = cq.Workplane("XY").transformed(offset=(100, 0, 0)).box(1, 1, 1).val()
    existing = cq.Workplane("XY").box(5, 5, 5).val()
    body_store = _make_body_store(existing)
    with pytest.raises(ValueError, match="^extrude:"):
        _call_helper(tool, body_store, operation="cut", op_name="extrude")


def test_error_prefix_uses_op_name_revolve():
    import cadquery as cq
    tool = cq.Workplane("XY").transformed(offset=(100, 0, 0)).box(1, 1, 1).val()
    existing = cq.Workplane("XY").box(5, 5, 5).val()
    body_store = _make_body_store(existing)
    with pytest.raises(ValueError, match="^revolve:"):
        _call_helper(tool, body_store, operation="cut", op_name="revolve")


# ─── Merge convention test ───


def test_sub_feature_merge_convention_feature_keys_win():
    """Verify the {**sub, **feature} merge: feature-level keys override sub-dict keys."""
    sub = {"distance": 5, "operation": "add"}
    feature = {**sub, **{"distance": 10, "operation": "new"}}
    # feature keys win over sub keys
    assert feature["distance"] == 10
    assert feature["operation"] == "new"


# ─── Body store mutation tests ───


def test_new_operation_populates_body_store():
    import cadquery as cq
    tool = cq.Workplane("XY").box(3, 3, 3).val()
    body_store: dict = {}
    _call_helper(tool, body_store, operation="new",
                 body_id="body_feat1", feature_id="feat1")
    assert len(body_store) >= 1
    assert "body_feat1" in body_store
    assert body_store["body_feat1"].created_by == "feat1"


def test_add_operation_mutates_existing_body():
    import cadquery as cq
    existing = cq.Workplane("XY").box(5, 5, 5).val()
    # Tool touches the existing body
    tool = cq.Workplane("XY").transformed(offset=(5, 0, 0)).box(5, 5, 5).val()
    body_store = _make_body_store(existing, body_id="body_b0", feature_id="b0")
    original_shape = body_store["body_b0"].shape
    _call_helper(tool, body_store, operation="add")
    # Shape should have been replaced (union)
    assert body_store["body_b0"].shape is not original_shape
