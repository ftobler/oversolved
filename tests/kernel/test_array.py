"""Test suite for array feature (linear, rectangular, rotational)."""
import importlib
import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]


def _linear_array_spec(count_x: int, pitch_x: float = 20, include_source: bool = True, box_w: float = 5):
    """Build a spec with a box and a linear array at count_x copies."""
    from solver_helpers import box_extrude_spec
    spec = box_extrude_spec(w=box_w, h=5, d=5, extrude_id="extrude1")
    spec["features"].append({
        "id": "arr1",
        "kind": "array",
        "array": {
            "source_body": "extrude1",
            "mode": "linear",
            "count_x": count_x,
            "pitch_x": pitch_x,
            "direction_x": [1, 0, 0],
            "operation": "add",
            "include_source": include_source,
        },
    })
    return spec


def _expected_x_max(count_x: int, pitch_x: float, box_w: float = 5) -> float:
    """Expected max X of fused mesh: last copy starts at (count_x-1)*pitch, width=box_w."""
    return (count_x - 1) * pitch_x + box_w


class TestArrayLinear:
    def test_linear_basic(self):
        """3 copies along X, pitch 20 -- resulting body bbox should span 40+epsilon in X."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid, assert_mesh_bbox

        r = build(_linear_array_spec(3, 20))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)
        assert_mesh_bbox(mesh, x_range=(0, 45), y_range=(0, 5), z_range=(0, 5))

    # ── Count verification: each count=N produces N copies  ──

    @pytest.mark.parametrize("count,expected_max", [
        (2, 25),   # (2-1)*20 + 5 = 25
        (3, 45),   # (3-1)*20 + 5 = 45
        (4, 65),   # (4-1)*20 + 5 = 65
        (5, 85),   # (5-1)*20 + 5 = 85
    ])
    def test_linear_count_include_source(self, count, expected_max):
        """count=N with include_source=True produces N copies."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(count, 20, include_source=True))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, expected_max), y_range=(0, 5), z_range=(0, 5))

    @pytest.mark.parametrize("count,expected_max", [
        (2, 25),   # transformed copy at 0, copy at 20
        (3, 45),   # copies at 0, 20, 40
        (4, 65),   # copies at 0, 20, 40, 60
        (5, 85),   # copies at 0, 20, 40, 60, 80
    ])
    def test_linear_count_no_source(self, count, expected_max):
        """count=N with include_source=False produces N transformed copies."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(count, 20, include_source=False))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, expected_max), y_range=(0, 5), z_range=(0, 5))

    @pytest.mark.parametrize("count,pitch,expected_max", [
        (4, 2, 11),   # (4-1)*2 + 5 = 11
        (4, 5, 20),   # (4-1)*5 + 5 = 20
    ])
    def test_linear_small_pitch(self, count, pitch, expected_max):
        """Small pitch (2,5) with count=4 produces correct extent."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(count, pitch))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, expected_max), y_range=(0, 5), z_range=(0, 5))

    # ── Edge cases  ──

    def test_linear_count_1(self):
        """count=1 with include_source=True should equal source shape -- no crash."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(1, 20))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, 5), y_range=(0, 5), z_range=(0, 5))

    def test_linear_count_1_no_source(self):
        """count=1 with include_source=False produces 1 transformed copy."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(1, 20, include_source=False))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(0, 5), y_range=(0, 5), z_range=(0, 5))

    def test_new_operation_creates_separate_body(self):
        """operation=new should not modify the source body and create body_arr1."""
        from oversolved.kernel.builder import build
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
        from oversolved.kernel.builder import build
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
        from oversolved.kernel.builder import build
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
        from oversolved.kernel.builder import build
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
        from oversolved.kernel.builder import build
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

    def test_missing_source_body_id_error(self):
        """Array with a non-existent source_body should report exception with available IDs."""
        from oversolved.kernel.builder import build
        from solver_helpers import box_extrude_spec

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append(
            {
                "id": "arr1",
                "kind": "array",
                "array": {
                    "source_body": "nonexistent_body",
                    "mode": "linear",
                    "count_x": 2,
                    "pitch_x": 10,
                    "direction_x": [1, 0, 0],
                    "operation": "add",
                },
            }
        )
        r = build(spec)
        assert r["result"]["arr1"]["status"] == "exception"
        assert "nonexistent_body" in r["result"]["arr1"]["exception"]
        assert "available" in r["result"]["arr1"]["exception"]
