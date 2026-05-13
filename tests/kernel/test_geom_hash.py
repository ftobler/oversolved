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

    def test_arc_different_spans_different_hash_deg_keys(self):
        """Arcs with same center/radius but different spans must not collide."""
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start_deg": 0.0, "angle_end_deg": 90.0,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start_deg": 0.0, "angle_end_deg": 180.0,
        })
        assert h1 != h2

    def test_arc_different_spans_different_hash_rad_keys(self):
        """Same check using radian key convention (OCC-extracted edges)."""
        import math
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start": 0.0, "angle_end": math.pi / 2,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start": 0.0, "angle_end": math.pi,
        })
        assert h1 != h2

    def test_arc_identical_produces_same_hash(self):
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [1, 2, 0], "radius": 3.0,
            "angle_start_deg": 45.0, "angle_end_deg": 135.0,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [1, 2, 0], "radius": 3.0,
            "angle_start_deg": 45.0, "angle_end_deg": 135.0,
        })
        assert h1 == h2

    def test_arc_missing_angle_keys_no_crash(self):
        """Edge dict without angle keys should not raise; defaults to 0.0."""
        h = edge_geometry_hash({"kind": "arc", "center": [0, 0, 0], "radius": 1.0})
        assert h.startswith("gedge_")

    def test_circle_unaffected_by_angle_logic(self):
        """Circles have no angle keys and should hash consistently."""
        h1 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        h2 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        assert h1 == h2

    def test_digest_length_16_chars(self):
        """Hex digest portion must be 16 characters (64 bits)."""
        h = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        hex_part = h.removeprefix("gedge_")
        assert len(hex_part) == 16

    def test_face_digest_length_16_chars(self):
        from oversolved.kernel.geom_hash import face_geometry_hash as fgh
        h = fgh([1, 2, 3], [0, 0, 1], 10.0)
        hex_part = h.removeprefix("gface_")
        assert len(hex_part) == 16

    def test_vertex_digest_length_16_chars(self):
        from oversolved.kernel.geom_hash import vertex_geometry_hash as vgh
        h = vgh([1.0, 2.0, 3.0])
        hex_part = h.removeprefix("gvertex_")
        assert len(hex_part) == 16


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
