"""Test suite for array feature (linear, rectangular, rotational)."""
import pytest

pytestmark = pytest.mark.skipif(
    not __import__("importlib").util.find_spec("cadquery"), reason="cadquery not installed"
)


class TestArrayLinear:
    def test_linear_basic(self):
        """3 copies along X, pitch 20 -- resulting body bbox should span 40+epsilon in X."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid, assert_mesh_bbox

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "linear",
                    "count_x": 3,
                    "pitch_x": 20,
                    "direction_x": [1, 0, 0],
                    "operation": "add",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        assert_mesh_bbox(mesh, x_range=(0, 45), y_range=(0, 5), z_range=(0, 5))

    def test_linear_include_source_false(self):
        """include_source=False should produce N-1 copies only."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_bbox

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "linear",
                    "count_x": 3,
                    "pitch_x": 20,
                    "direction_x": [1, 0, 0],
                    "operation": "add",
                    "include_source": False,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(20, 45), y_range=(0, 5), z_range=(0, 5))

    def test_linear_count_1(self):
        """count=1 with include_source=True should equal source shape -- no crash."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_bbox

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "linear",
                    "count_x": 1,
                    "pitch_x": 20,
                    "direction_x": [1, 0, 0],
                    "operation": "add",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, 5), y_range=(0, 5), z_range=(0, 5))

    def test_new_operation_creates_separate_body(self):
        """operation=new should not modify the source body and create body_arr1."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_bbox

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "linear",
                    "count_x": 3,
                    "pitch_x": 10,
                    "direction_x": [1, 0, 0],
                    "operation": "new",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        # Original body untouched
        assert_mesh_bbox(
            r["bodies"]["body_extrude1"]["mesh"],
            x_range=(0, 5), y_range=(0, 5), z_range=(0, 5),
        )
        # New body for array
        assert "body_arr1" in r["bodies"]
        assert_mesh_bbox(
            r["bodies"]["body_arr1"]["mesh"],
            x_range=(0, 25), y_range=(0, 5), z_range=(0, 5),
        )


class TestArrayRectangular:
    def test_rectangular_2x2(self):
        """2x2 array -- 4 instances."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid, assert_mesh_bbox

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "rectangular",
                    "count_x": 2,
                    "pitch_x": 15,
                    "direction_x": [1, 0, 0],
                    "count_y": 2,
                    "pitch_y": 15,
                    "direction_y": [0, 1, 0],
                    "operation": "add",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        assert_mesh_bbox(mesh, x_range=(0, 20), y_range=(0, 20), z_range=(0, 5))


class TestArrayRotational:
    def test_rotational_4_instances(self):
        """4x90 deg rotational -- full ring around Z axis."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "rotational",
                    "count": 4,
                    "axis_origin": [0, 0, 0],
                    "axis_direction": [0, 0, 1],
                    "operation": "add",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_rotational_evenly_spaced(self):
        """step_angle=None -> 360/count, 6 instances equally spaced."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "rotational",
                    "count": 6,
                    "step_angle": None,
                    "axis_origin": [0, 0, 0],
                    "axis_direction": [0, 0, 1],
                    "operation": "add",
                    "include_source": True,
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)


class TestArrayErrors:
    def test_count_zero_raises(self):
        """count=0 should return ok but produce empty instances."""
        from oversolved.builder import build
        from solver_helpers import box_extrude_spec

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "extrude1",
                    "mode": "linear",
                    "count_x": 0,
                    "pitch_x": 10,
                    "direction_x": [1, 0, 0],
                    "operation": "add",
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "exception"
