"""Unit tests for Frame3D dataclass."""

import pytest
import numpy as np
from oversolved.kernel.types3d import Frame3D, FRONT, TOP, RIGHT


class TestFrame3DConstruction:
    def test_from_dict_round_trip(self):
        d = {"origin": [1, 2, 3], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]}
        frame = Frame3D.from_dict(d)
        assert frame.to_dict() == d

    def test_from_dict_strips_extra_keys(self):
        d = {"origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1], "type": "plane"}
        frame = Frame3D.from_dict(d)
        assert "type" not in frame.to_dict()

    def test_from_dict_rejects_missing_keys(self):
        with pytest.raises(KeyError):
            Frame3D.from_dict({"origin": [0, 0, 0], "x_axis": [1, 0, 0]})

    def test_from_arrays_round_trip(self):
        o = np.array([1.0, 2.0, 3.0])
        x = np.array([1.0, 0.0, 0.0])
        y = np.array([0.0, 1.0, 0.0])
        n = np.array([0.0, 0.0, 1.0])
        frame = Frame3D.from_arrays(o, x, y, n)
        assert frame.to_dict() == {"origin": [1, 2, 3], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]}

    def test_plane_transform_round_trip(self):
        pt = {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "origin": [0, 0, 0]}
        frame = Frame3D.from_plane_transform(pt)
        assert frame.to_plane_transform() == pt

    def test_frozen_immutability(self):
        frame = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 1, 0], normal=[0, 0, 1])
        with pytest.raises((AttributeError, Exception)):
            frame.origin = [1, 2, 3]

    def test_frozen_list_append_allowed(self):
        frame = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 1, 0], normal=[0, 0, 1])
        frame.origin.append(4)
        assert len(frame.origin) == 4


class TestFrame3DConstants:
    def test_front_normal(self):
        assert FRONT.normal == [0, 0, 1]

    def test_top_normal(self):
        assert TOP.normal == [0, 1, 0]

    def test_right_normal(self):
        assert RIGHT.normal == [1, 0, 0]

    def test_right_handed_front(self):
        from numpy import cross
        assert cross(FRONT.x_axis, FRONT.y_axis).tolist() == FRONT.normal

    def test_right_handed_top(self):
        from numpy import cross
        assert cross(TOP.x_axis, TOP.y_axis).tolist() == TOP.normal

    def test_right_handed_right(self):
        from numpy import cross
        assert cross(RIGHT.x_axis, RIGHT.y_axis).tolist() == RIGHT.normal


class TestFrame3DFromNormal:
    def test_from_normal_z_aligned(self):
        frame = Frame3D.from_normal([0, 0, 1])
        assert frame.normal == [0, 0, 1]
        assert frame.origin == [0, 0, 0]
        mag_x = sum(v * v for v in frame.x_axis) ** 0.5
        mag_y = sum(v * v for v in frame.y_axis) ** 0.5
        assert abs(mag_x - 1.0) < 1e-10
        assert abs(mag_y - 1.0) < 1e-10

    def test_from_normal_with_origin(self):
        frame = Frame3D.from_normal([0, 1, 0], [1, 2, 3])
        assert frame.origin == [1, 2, 3]
        assert frame.normal == [0, 1, 0]

    def test_from_normal_orthonormal(self):
        frame = Frame3D.from_normal([0, 0, 1])
        dot = sum(frame.x_axis[i] * frame.y_axis[i] for i in range(3))
        assert abs(dot) < 1e-10


class TestFrame3DCQPlane:
    def test_cq_plane_round_trip(self):
        pytest.importorskip("cadquery")
        from cadquery.occ_impl.geom import Plane as CQPlane
        cq_plane = CQPlane(origin=(1, 2, 3), xDir=(1, 0, 0), normal=(0, 0, 1))
        frame = Frame3D.from_cq_plane(cq_plane)
        cq_back = frame.to_cq_plane()
        assert list(cq_back.origin.toTuple()) == [1, 2, 3]
        assert list(cq_back.xDir.toTuple()) == pytest.approx([1, 0, 0], abs=1e-10)
        assert list(cq_back.zDir.toTuple()) == pytest.approx([0, 0, 1], abs=1e-10)
