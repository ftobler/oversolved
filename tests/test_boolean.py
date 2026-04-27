"""Test suite for boolean feature (union, subtract, intersect)."""
import pytest

from oversolved.types3d import Body
from oversolved.solver import _resolve_body, _solve_boolean

pytestmark = pytest.mark.skipif(
    not __import__("importlib").util.find_spec("cadquery"), reason="cadquery not installed"
)


def _make_box(x, y, z, w, h, d):
    """Create a box solid with corner at (x,y,z) and size (w,h,d)."""
    from cadquery.occ_impl.shapes import Face, Solid
    from cadquery.occ_impl.geom import Vector as CQVector

    return Solid.extrudeLinear(
        Face.makePlane(w, h, (x, y, z)),
        CQVector(0, 0, d),
    )


def _box_body(bid, x, y, z, w, h, d):
    """Create a Body containing a box solid."""
    return Body(id=bid, created_by=bid.replace("body_", ""), shape=_make_box(x, y, z, w, h, d))


class TestResolveBody:
    def test_resolve_body_with_body_prefix(self):
        """@body_extrude1 should resolve when key is body_extrude1."""
        body = _box_body("body_extrude1", 0, 0, 0, 1, 1, 1)
        store = {"body_extrude1": body}
        assert _resolve_body("@body_extrude1", store) is body

    def test_resolve_body_with_feature_id(self):
        """@extrude1 should resolve to body_extrude1."""
        body = _box_body("body_extrude1", 0, 0, 0, 1, 1, 1)
        store = {"body_extrude1": body}
        assert _resolve_body("@extrude1", store) is body

    def test_resolve_body_direct_key(self):
        """@extrude1 should resolve directly if key exists without body_ prefix."""
        body = _box_body("extrude1", 0, 0, 0, 1, 1, 1)
        store = {"extrude1": body}
        assert _resolve_body("@extrude1", store) is body

    def test_resolve_body_not_found_raises(self):
        """Invalid body reference should raise ValueError."""
        with pytest.raises(ValueError, match="body not found"):
            _resolve_body("@missing", {})


class TestSolveBooleanDirect:
    def test_boolean_union(self):
        """Union of two 4x4x4 boxes should have volume 64 (complete overlap)."""
        target = _box_body("body_target", 0, 0, 0, 4, 4, 4)
        tool = _box_body("body_tool", 0, 0, 0, 4, 4, 4)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {"operation": "union", "target": "@body_target", "tools": ["@body_tool"]},
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "ok"
        assert result["body_id"] == "body_target"
        assert target.shape.Volume() == pytest.approx(64.0, abs=1e-3)
        assert "body_tool" not in store

    def test_boolean_subtract(self):
        """Subtract a 4x4x2 box from a 4x4x4 box should leave volume 32."""
        target = _box_body("body_target", 0, 0, 0, 4, 4, 4)
        tool = _box_body("body_tool", 0, 0, 0, 4, 4, 2)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {"operation": "subtract", "target": "@body_target", "tools": ["@body_tool"]},
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "ok"
        assert target.shape.Volume() == pytest.approx(32.0, abs=1e-3)

    def test_boolean_intersect(self):
        """Intersect a 4x4x4 box with a 4x4x2 box should produce volume 32."""
        target = _box_body("body_target", 0, 0, 0, 4, 4, 4)
        tool = _box_body("body_tool", 0, 0, 0, 4, 4, 2)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {"operation": "intersect", "target": "@body_target", "tools": ["@body_tool"]},
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "ok"
        assert target.shape.Volume() == pytest.approx(32.0, abs=1e-3)

    def test_boolean_multiple_tools(self):
        """Boolean with two tools should consume both."""
        target = _box_body("body_target", 0, 0, 0, 10, 10, 10)
        tool1 = _box_body("body_tool1", 0, 0, 0, 2, 2, 2)
        tool2 = _box_body("body_tool2", 3, 0, 0, 2, 2, 2)
        store = {"body_target": target, "body_tool1": tool1, "body_tool2": tool2}
        feature = {
            "id": "bool1",
            "boolean": {
                "operation": "subtract",
                "target": "@body_target",
                "tools": ["@body_tool1", "@body_tool2"],
            },
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "ok"
        assert "body_tool1" not in store
        assert "body_tool2" not in store

    def test_boolean_keep_tools(self):
        """keep_tools=True should leave tool bodies in body_store."""
        target = _box_body("body_target", 0, 0, 0, 4, 4, 4)
        tool = _box_body("body_tool", 0, 0, 0, 4, 4, 2)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {
                "operation": "union",
                "target": "@body_target",
                "tools": ["@body_tool"],
                "keep_tools": True,
            },
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "ok"
        assert "body_tool" in store

    def test_boolean_missing_target(self):
        """Missing target should return exception status."""
        feature = {
            "id": "bool1",
            "boolean": {"operation": "union", "target": "", "tools": ["@tool"]},
        }
        result = _solve_boolean(feature, None, {})
        assert result["status"] == "exception"
        assert "target" in result["exception"].lower()

    def test_boolean_missing_tools(self):
        """Empty tools list should return exception status."""
        feature = {
            "id": "bool1",
            "boolean": {"operation": "union", "target": "@target", "tools": []},
        }
        result = _solve_boolean(feature, None, {})
        assert result["status"] == "exception"
        assert "tools" in result["exception"].lower()

    def test_boolean_unknown_operation(self):
        """Unknown operation should return exception status."""
        target = _box_body("body_target", 0, 0, 0, 1, 1, 1)
        tool = _box_body("body_tool", 0, 0, 0, 1, 1, 1)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {
                "operation": "xor",
                "target": "@body_target",
                "tools": ["@body_tool"],
            },
        }
        result = _solve_boolean(feature, None, store)
        assert result["status"] == "exception"
        assert "unknown operation" in result["exception"].lower()

    def test_boolean_target_not_found(self):
        """Target body that does not exist should return exception status."""
        feature = {
            "id": "bool1",
            "boolean": {"operation": "union", "target": "@missing", "tools": ["@tool"]},
        }
        result = _solve_boolean(feature, None, {})
        assert result["status"] == "exception"

    def test_boolean_modifies_target_modified_by(self):
        """Target body should record the boolean feature id in modified_by."""
        target = _box_body("body_target", 0, 0, 0, 4, 4, 4)
        tool = _box_body("body_tool", 0, 0, 0, 4, 4, 2)
        store = {"body_target": target, "body_tool": tool}
        feature = {
            "id": "bool1",
            "boolean": {"operation": "union", "target": "@body_target", "tools": ["@body_tool"]},
        }
        _solve_boolean(feature, None, store)
        assert "bool1" in target.modified_by


class TestBooleanBuilder:
    def test_boolean_union_through_builder(self):
        """Builder-level union of two boxes should produce one merged body."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid, assert_mesh_bbox

        spec = box_extrude_spec(w=4, h=4, d=4, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "extrude2",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 4,
                "direction": "normal",
                "operation": "new",
            }
        )
        spec["features"].append(
            {
                "id": "bool1",
                "kind": "boolean",
                "boolean": {
                    "operation": "union",
                    "target": "@extrude1",
                    "tools": ["@extrude2"],
                },
            }
        )
        r = build(spec)
        assert r["result"]["bool1"]["status"] == "ok", r["result"]["bool1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(0, 4))

    def test_boolean_subtract_through_builder(self):
        """Builder-level subtract should reduce target body volume."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid, assert_mesh_bbox

        spec = box_extrude_spec(w=4, h=4, d=4, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "extrude2",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 2,
                "direction": "normal",
                "operation": "new",
            }
        )
        spec["features"].append(
            {
                "id": "bool1",
                "kind": "boolean",
                "boolean": {
                    "operation": "subtract",
                    "target": "@extrude1",
                    "tools": ["@extrude2"],
                },
            }
        )
        r = build(spec)
        assert r["result"]["bool1"]["status"] == "ok", r["result"]["bool1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        # Target was 4x4x4, tool was 4x4x2 at same position -> remaining is 4x4x2 at z=2..4
        assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(2, 4))

    def test_boolean_intersect_through_builder(self):
        """Builder-level intersect should keep only overlapping region."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid, assert_mesh_bbox

        spec = box_extrude_spec(w=4, h=4, d=4, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "extrude2",
                "kind": "extrude",
                "sketch": "$sk1",
                "distance": 2,
                "direction": "normal",
                "operation": "new",
            }
        )
        spec["features"].append(
            {
                "id": "bool1",
                "kind": "boolean",
                "boolean": {
                    "operation": "intersect",
                    "target": "@extrude1",
                    "tools": ["@extrude2"],
                },
            }
        )
        r = build(spec)
        assert r["result"]["bool1"]["status"] == "ok", r["result"]["bool1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        # Intersection of 4x4x4 and 4x4x2 at same position -> 4x4x2 at z=0..2
        assert_mesh_bbox(mesh, x_range=(0, 4), y_range=(0, 4), z_range=(0, 2))
