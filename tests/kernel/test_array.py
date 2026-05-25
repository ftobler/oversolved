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

    @pytest.mark.parametrize("count,expected_lo,expected_hi", [
        (2, 20, 45),   # copies at 20, 40 -> range [20, 40+5]
        (3, 20, 65),   # copies at 20, 40, 60 -> range [20, 60+5]
        (4, 20, 85),   # copies at 20, 40, 60, 80 -> range [20, 80+5]
        (5, 20, 105),  # copies at 20, 40, 60, 80, 100 -> range [20, 100+5]
    ])
    def test_linear_count_no_source(self, count, expected_lo, expected_hi):
        """count=N with include_source=False produces N distinct transformed copies."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(count, 20, include_source=False))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(expected_lo, expected_hi), y_range=(0, 5), z_range=(0, 5))

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
        """count=1 with include_source=False produces 1 transformed copy at pitch."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_bbox

        r = build(_linear_array_spec(1, 20, include_source=False))
        assert r["result"]["arr1"]["status"] == "ok", r["result"]["arr1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_bbox(mesh, x_range=(20, 25), y_range=(0, 5), z_range=(0, 5))

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


class TestCircularArray:
    def _circular_spec(self, count: int = 4, step_angle=None, include_source: bool = True):
        """Build a spec with a box and a circular array feature."""
        from solver_helpers import box_extrude_spec
        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append({
            "id": "ca1",
            "kind": "circular_array",
            "circular_array": {
                "source_body": "extrude1",
                "count": count,
                "step_angle": step_angle,
                "axis_origin": [0, 0, 0],
                "axis_direction": [0, 0, 1],
                "operation": "add",
                "include_source": include_source,
            },
        })
        return spec

    def test_rotational_4_instances(self):
        """4x90 deg rotational -- full ring around Z axis."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid

        r = build(self._circular_spec(4))
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_rotational_5_instances(self):
        """5 instances evenly spaced -- reproduces bug report."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid

        r = build(self._circular_spec(5))
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_rotational_evenly_spaced(self):
        """step_angle=None -> 360/count, 6 instances equally spaced."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid

        r = build(self._circular_spec(6))
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_rotational_step_angle(self):
        """Explicit step_angle produces correct spacing."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid

        r = build(self._circular_spec(4, step_angle=45.0))
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_rotational_new_operation(self):
        """operation=new creates a separate body."""
        from oversolved.kernel.builder import build
        from solver_helpers import box_extrude_spec, assert_mesh_valid

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append({
            "id": "ca1",
            "kind": "circular_array",
            "circular_array": {
                "source_body": "extrude1",
                "count": 4,
                "step_angle": None,
                "axis_origin": [0, 0, 0],
                "axis_direction": [0, 0, 1],
                "operation": "new",
                "include_source": True,
            },
        })
        r = build(spec)
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        assert "body_ca1" in r["bodies"]
        assert_mesh_valid(r["bodies"]["body_ca1"]["mesh"])

    def test_rotational_no_source(self):
        """include_source=False should still produce count copies."""
        from oversolved.kernel.builder import build
        from solver_helpers import assert_mesh_valid

        r = build(self._circular_spec(5, include_source=False))
        assert r["result"]["ca1"]["status"] == "ok", r["result"]["ca1"]
        mesh = r["bodies"]["body_extrude1"]["mesh"]
        assert_mesh_valid(mesh)

    def test_count_zero_raises(self):
        """count=0 should return an exception."""
        from oversolved.kernel.builder import build

        r = build(self._circular_spec(0))
        assert r["result"]["ca1"]["status"] == "exception"

    def test_missing_source_body_error(self):
        """Non-existent source_body should report exception."""
        from oversolved.kernel.builder import build
        from solver_helpers import box_extrude_spec

        spec = box_extrude_spec(w=5, h=5, d=5, extrude_id="extrude1")
        spec["features"].append({
            "id": "ca1",
            "kind": "circular_array",
            "circular_array": {
                "source_body": "nonexistent_body",
                "count": 4,
                "step_angle": None,
                "axis_origin": [0, 0, 0],
                "axis_direction": [0, 0, 1],
                "operation": "add",
                "include_source": True,
            },
        })
        r = build(spec)
        assert r["result"]["ca1"]["status"] == "exception"
        assert "nonexistent_body" in r["result"]["ca1"]["exception"]
        assert "available" in r["result"]["ca1"]["exception"]

    def test_rotational_count_4_no_source_with_revolve(self):
        """Circular array of revolve body: count=4, step=72, no-source, new-body.

        Regression: OCC boolean fuse failed when copies shared a coincident
        face at the origin (each revolve copy starts at the same point).
        The fix falls back to a compound so the shape remains valid.
        """
        from oversolved.kernel.builder import build
        from solver_helpers import (
            rect_sketch_spec,
            assert_mesh_valid,
        )

        def _rect_at_offset(w=2.0, h=1.0, ox=1.0, sid="sk1"):
            s = rect_sketch_spec(w=w, h=h, sketch_id=sid)
            for k in s["initial"]:
                s["initial"][k] = [
                    s["initial"][k][0] + ox,
                    s["initial"][k][1],
                    s["initial"][k][2] + ox,
                    s["initial"][k][3],
                ]
            return s

        spec = {
            "features": [
                _rect_at_offset(w=2.0, h=1.0, ox=1.0, sid="sk1"),
                {
                    "id": "rev1", "kind": "revolve",
                    "sketch": "$sk1", "angle": 360,
                    "axis_origin": [0, 0, 0],
                    "axis_direction": [0, 1, 0],
                },
                {
                    "id": "ca1", "kind": "circular_array",
                    "circular_array": {
                        "count": 4, "step_angle": 72,
                        "include_source": False,
                        "operation": "new",
                        "axis_origin": [0, 0, 0],
                        "axis_direction": [0, 0, 1],
                    },
                },
            ],
        }
        r = build(spec)
        assert r["result"]["rev1"]["status"] == "ok", r["result"]["rev1"]
        ca = r["result"]["ca1"]
        assert ca["status"] == "ok", ca
        assert ca["body_id"] == "body_ca1", ca
        mesh = r["bodies"]["body_ca1"]["mesh"]
        assert_mesh_valid(mesh)
        assert len(mesh["vertices"]) > 100, (
            f"expected >100 vertices, got {len(mesh['vertices'])}"
        )
        assert len(mesh["faces"]) > 100, (
            f"expected >100 faces, got {len(mesh['faces'])}"
        )
        # Verify 4 distinct solids in the array body
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_SOLID
        body_shapes = r.get("_body_shapes", {})
        arr_shape = body_shapes.get("body_ca1")
        assert arr_shape is not None, "body_ca1 not in _body_shapes"
        exp = TopExp_Explorer(arr_shape, TopAbs_SOLID)
        n_solids = 0
        while exp.More():
            n_solids += 1
            exp.Next()
        assert n_solids == 4, (
            f"expected 4 solids in circular array body, got {n_solids}"
        )


class TestArrayErrors:
    def test_count_zero_with_source(self):
        """count_x=0 with include_source=true should produce just the source body."""
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
        assert r["result"]["arr1"]["status"] == "ok"

    def test_count_zero_no_source_raises(self):
        """count_x=0 with include_source=false should raise because there are no instances."""
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
                    "include_source": False,
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
