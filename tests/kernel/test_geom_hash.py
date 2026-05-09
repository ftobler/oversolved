"""Unit tests for geometry hash functions."""

from oversolved.kernel.geom_hash import (
    face_geometry_hash,
    edge_geometry_hash,
    vertex_geometry_hash,
)


class TestFaceGeometryHash:
    def test_deterministic(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        assert h1 == h2
        assert h1.startswith("gface_")

    def test_different_centroid_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([4, 2, 3], [0, 0, 1], 10.0)
        assert h1 != h2

    def test_different_normal_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [1, 0, 0], 10.0)
        assert h1 != h2

    def test_different_area_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [0, 0, 1], 20.0)
        assert h1 != h2


class TestEdgeGeometryHash:
    def test_line_deterministic(self):
        h1 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 1, 1]})
        h2 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 1, 1]})
        assert h1 == h2
        assert h1.startswith("gedge_")

    def test_line_distinct_from_arc(self):
        line_h = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        arc_h = edge_geometry_hash({"kind": "arc", "center": [0.5, 0, 0], "radius": 0.5})
        assert line_h != arc_h

    def test_circle_hash(self):
        h = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        assert h.startswith("gedge_")

    def test_arc_hash(self):
        h = edge_geometry_hash({"kind": "arc", "center": [1, 2, 0], "radius": 3.0})
        assert h.startswith("gedge_")

    def test_different_radius_different_hash(self):
        h1 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        h2 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 10.0})
        assert h1 != h2

    def test_different_start_different_hash(self):
        h1 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        h2 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [2, 0, 0]})
        assert h1 != h2

    def test_spline_hash(self):
        h = edge_geometry_hash({"kind": "spline", "points": [[0, 0, 0], [1, 1, 1], [2, 2, 2]]})
        assert h.startswith("gedge_")


class TestVertexGeometryHash:
    def test_deterministic(self):
        h1 = vertex_geometry_hash([1.0, 2.0, 3.0])
        h2 = vertex_geometry_hash([1.0, 2.0, 3.0])
        assert h1 == h2
        assert h1.startswith("gvertex_")

    def test_different_position_different_hash(self):
        h1 = vertex_geometry_hash([1.0, 2.0, 3.0])
        h2 = vertex_geometry_hash([4.0, 2.0, 3.0])
        assert h1 != h2
